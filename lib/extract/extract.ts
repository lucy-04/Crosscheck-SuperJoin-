/**
 * Stage 3: extraction unit -> scoped claims.
 *
 * The only place in the pipeline where the model is asked to perceive. It is not
 * asked to judge, compare, or reconcile anything — those are stages 4 through 7,
 * and they are deterministic. Keeping the boundary sharp is what makes every
 * verdict this system reaches reproducible and inspectable.
 */

import { generateObject, NoObjectGeneratedError } from "ai";
import type { ScopedClaim } from "@/lib/types";
import { config, loadEnv } from "@/lib/env";
import { allModels, isExhausted, languageModel, markExhausted, modelChain, providerOptions } from "@/lib/model";
import { estimateTokens, getRateLimiter, retryAfterSeconds, sleep } from "@/lib/rate-limit";
import { renderUnitForPrompt, type ExtractionUnit } from "@/lib/ingest/segment";
import { cacheKey, CacheStats, readCache, writeCache } from "./cache";
import {
  ExtractionSchema,
  PROMPT_VERSION,
  SYSTEM_PROMPT,
  toScopedClaim,
  type RawClaim,
} from "./schema";

export interface ExtractOptions {
  model?: string;
  concurrency?: number;
  /** Document publication date, stamped onto every claim for vintage ordering. */
  assertedAsOf?: string | null;
  onProgress?: (done: number, total: number, stats: CacheStats) => void;
  signal?: AbortSignal;
}

export interface UnitExtraction {
  unit: ExtractionUnit;
  claims: ScopedClaim[];
  /** Populated when the call failed outright, so failures are counted not lost. */
  error?: string;
}

/** Thrown when a cache miss needs the network but no key is configured. */
export class MissingApiKeyError extends Error {
  constructor() {
    super(
      "No model provider key is set, and this document is not in the committed cache.\n" +
        "Set ANTHROPIC_API_KEY or GEMINI_API_KEY in .env.local to ingest new documents,\n" +
        "or run `npm run demo` to replay the six starter PDFs from cache with no key.",
    );
    this.name = "MissingApiKeyError";
  }
}

const RETRYABLE = /rate.?limit|overloaded|timeout|ECONNRESET|fetch failed|5\d\d/i;

/**
 * A spent DAILY budget, as distinct from a per-minute one. The difference
 * matters: a per-minute limit refills while you wait, a daily limit does not, so
 * retrying against it burns the whole run. Free tiers meter per model, so the
 * right response is to move down the chain rather than back off.
 */
const DAILY_QUOTA = /tokens per day|TPD|per day \(|requests per day|RPD|free_tier_requests/i;

/**
 * Extract one unit, consulting the cache first.
 *
 * A malformed response is retried once and then allowed to fail: an empty result
 * for one chunk is a far better outcome than a crashed 100-page ingest, and the
 * failure is recorded rather than swallowed.
 */
export async function extractUnit(
  unit: ExtractionUnit,
  opts: ExtractOptions = {},
  stats = new CacheStats(),
): Promise<UnitExtraction> {
  loadEnv();
  const prompt = renderUnitForPrompt(unit);

  // Look for a cached answer under ANY model in the chain, not just the current
  // one. Work already paid for should never be discarded because the preferred
  // model has since run out of daily quota.
  const keyFor = (m: string) =>
    cacheKey({ model: m, promptVersion: PROMPT_VERSION, kind: "extract", payload: prompt });

  for (const candidate of opts.model ? [opts.model] : allModels()) {
    const cached = readCache<RawClaim[]>(keyFor(candidate));
    if (cached) {
      stats.hits++;
      return { unit, claims: liftAll(cached, unit, opts) };
    }
  }
  stats.misses++;

  if (!config.hasApiKey) throw new MissingApiKeyError();

  const limiter = getRateLimiter(config.limits);
  const cost = estimateTokens(SYSTEM_PROMPT + prompt);

  let lastError: unknown;

  // Outer loop walks the model chain; inner loop retries within one model.
  for (const candidate of opts.model ? [opts.model] : modelChain()) {
    if (isExhausted(candidate)) continue;

    // A rate-limited call is not a failure, so it gets far more attempts than a
    // malformed response would justify — the budget refills, it just takes time.
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        // Pace against the quota rather than discovering it by being rejected.
        await limiter.acquire(cost, opts.signal);
        const { object } = await generateObject({
          model: languageModel(candidate),
          schema: ExtractionSchema,
          system: SYSTEM_PROMPT,
          prompt,
          temperature: 0,
          // Groq bills the RESERVED output budget against its tokens-per-minute
          // limit, not the tokens actually generated. Left unset, the provider
          // default reserved several thousand tokens per call that we never used,
          // roughly halving throughput. This ceiling comfortably fits the fact
          // cap the prompt asks for.
          maxOutputTokens: 1800,
          providerOptions: providerOptions("extract"),
          abortSignal: opts.signal,
        });

        writeCache(keyFor(candidate), object.facts, { model: candidate, promptVersion: PROMPT_VERSION });
        return { unit, claims: liftAll(object.facts, unit, opts) };
      } catch (err) {
        lastError = err;
        const message = err instanceof Error ? err.message : String(err);

        // A spent DAILY budget will not refill within this run. Retrying is pure
        // waste; the next model in the chain has its own budget, so move on and
        // remember not to try this one again.
        if (DAILY_QUOTA.test(message)) {
          markExhausted(candidate);
          break;
        }

        // The provider usually says exactly how long to wait; obeying that beats
        // a guessed backoff, which either wastes time or retries into the wall.
        const wait = retryAfterSeconds(message);
        if (wait !== null) {
          limiter.penalise(wait);
          await sleep(wait * 1000 + 250, opts.signal);
          continue;
        }

        // A schema violation will not fix itself on retry at temperature 0, so it
        // is only worth one more attempt; transient errors get backed off.
        const retryable = RETRYABLE.test(message) || NoObjectGeneratedError.isInstance(err);
        if (!retryable || attempt >= 3) break;
        await sleep(500 * 2 ** attempt + Math.random() * 250, opts.signal);
      }
    }
  }

  return {
    unit,
    claims: [],
    error: lastError instanceof Error ? lastError.message : String(lastError),
  };
}

function liftAll(raw: RawClaim[], unit: ExtractionUnit, opts: ExtractOptions): ScopedClaim[] {
  return raw.map((r) =>
    toScopedClaim(r, {
      pageNumber: unit.pageNumber,
      assertedAsOf: opts.assertedAsOf ?? null,
    }),
  );
}

/**
 * Run extraction across many units with bounded concurrency.
 *
 * A plain `Promise.all` over 700 units would open 700 sockets and be rate-limited
 * into failure; a sequential loop would take an hour. The pool keeps a fixed
 * number in flight and reports progress as results land.
 */
export async function extractUnits(
  units: ExtractionUnit[],
  opts: ExtractOptions = {},
): Promise<{ results: UnitExtraction[]; stats: CacheStats }> {
  const stats = new CacheStats();
  const salient = units.filter((u) => u.salient);
  const results: UnitExtraction[] = new Array(salient.length);

  const limit = Math.max(1, opts.concurrency ?? config.concurrency);
  let next = 0;
  let done = 0;

  // A unit that needs the network with no key available is a per-unit failure,
  // not a fatal one. A document that is 95% cached should yield its 95% rather
  // than abort entirely — partial knowledge is the whole point of a committed
  // cache. Only a document with NOTHING cached is a hard error worth raising.
  let missingKey = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= salient.length) return;
      try {
        results[i] = await extractUnit(salient[i], opts, stats);
      } catch (err) {
        if (err instanceof MissingApiKeyError) {
          missingKey++;
          results[i] = { unit: salient[i], claims: [], error: err.message.split("\n")[0] };
        } else {
          throw err;
        }
      }
      done++;
      opts.onProgress?.(done, salient.length, stats);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, salient.length) }, worker));

  if (salient.length && missingKey === salient.length) throw new MissingApiKeyError();

  return { results, stats };
}
