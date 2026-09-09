/**
 * LLM adjudication of vocabulary candidates.
 *
 * Called only for the shortlist embeddings could not decide. The calibration that
 * forced this design (measured on the real label set, recorded in progress.md):
 *
 *     0.6950  revenue from operations <-> number of employees   (different)
 *     0.6871  gurugram                <-> gurgaon               (same)
 *     0.8833  revenue from operations <-> revenue               (same-ish)
 *     0.8783  adjusted ebitda         <-> ebitda                (different!)
 *     0.8389  registered office       <-> corporate office      (different!)
 *
 * There is no threshold that separates same from different. Embeddings give
 * recall; this gives precision.
 *
 * The shortlist is judged in ONE call rather than one call per candidate. That is
 * not tidiness: under the measured 15 requests/minute budget, three separate
 * calls per new label would put canonicalisation of the starter corpus at over an
 * hour — longer than extraction itself. It also produces better answers, because
 * a model shown the alternatives together picks the best match rather than
 * accepting the first plausible one.
 *
 * Because the registry persists and responses are cached by content hash, each
 * distinct label is adjudicated once for the life of the corpus.
 */

import { generateObject } from "ai";
import { z } from "zod";
import { config, loadEnv } from "@/lib/env";
import { isExhausted, languageModel, markExhausted, modelChain } from "@/lib/model";
import { estimateTokens, getRateLimiter } from "@/lib/rate-limit";
import { cacheKey, readCache, writeCache } from "@/lib/extract/cache";
import type { Namespace } from "./store";

export const ADJUDICATE_VERSION = "v2";

export type AdjudicationRelation =
  | "same"
  | "a_broader_than_b"
  | "b_broader_than_a"
  | "exclusive"
  | "compatible"
  | "different";

const RELATIONS: Record<Namespace, [string, ...string[]]> = {
  predicate: ["same", "a_broader_than_b", "b_broader_than_a", "different"],
  subject: ["same", "different"],
  value: ["same", "exclusive", "compatible", "different"],
};

function schemaFor(namespace: Namespace) {
  return z.object({
    match: z
      .number()
      .int()
      .describe("Index of the best-matching candidate (1-based), or 0 if none relate"),
    relation: z.enum(RELATIONS[namespace]),
    reason: z.string().describe("One short sentence"),
  });
}

export interface Adjudication {
  /** Index into the candidate array, or null when nothing matched. */
  matchIndex: number | null;
  relation: AdjudicationRelation;
  reason: string;
  /** True when no key was available and the conservative default was used. */
  fallback?: boolean;
}

const PROMPTS: Record<Namespace, string> = {
  predicate: `You align measurement labels drawn from financial and economic documents.

You are given one LABEL and a numbered list of EXISTING labels. Choose the existing
label that refers to the same measurable quantity, and say how they relate:

- "same"             they measure the identical quantity and could be compared directly
- "a_broader_than_b" the LABEL is an aggregate that includes the chosen candidate
- "b_broader_than_a" the chosen candidate is an aggregate that includes the LABEL
- "different"        none of the candidates relate; answer with match 0

Be strict. Reporting conventions draw fine distinctions on purpose, and merging
two labels that are merely similar produces false contradictions downstream.
"Adjusted EBITDA" is NOT "EBITDA" — the adjustments are the point. "Revenue from
operations" is NOT "total income" — total income adds other income, so that is a
broader/narrower relation, not sameness. When genuinely unsure, answer match 0
with "different": a missed link costs one uncompared pair, a wrong link corrupts
a verdict.`,

  subject: `You decide which, if any, of the numbered EXISTING names refers to the
same real-world entity as the given NAME.

Answer "same" only for the same company, person, place or institution written
differently — abbreviations, honorifics, legal-form suffixes, or former names.

Answer match 0 with "different" for a parent and its subsidiary, two people who
share a surname, or an entity and the group it belongs to. When unsure, answer 0.`,

  value: `You decide how a stated VALUE relates to numbered EXISTING values of the
same kind of property.

- "same"        assert the identical thing written differently
                ("Gurgaon" / "Gurugram", "Plot No. 5" / "Plot 5")
- "exclusive"   cannot both be true of the same subject at the same time
                ("resigned" vs "in office", "approved" vs "pending")
- "compatible"  can both be true at once
                ("Director" and "Chairman", "Managing Director" and "CEO")
- "different"   neither the same nor logically related; answer match 0

"exclusive" is the important one: it is what lets a knowledge layer detect that a
person cannot simultaneously hold and have vacated an office.`,
};

/**
 * Judge one label against a shortlist of existing entries in a single call.
 *
 * With no provider key and no cache entry, returns "different" rather than
 * throwing. That is the conservative direction: the system under-links instead of
 * inventing a relation it cannot justify, and the fallback is flagged so the UI
 * can say so.
 */
export async function adjudicateAgainst(
  namespace: Namespace,
  label: string,
  candidates: string[],
): Promise<Adjudication> {
  loadEnv();
  const model = config.model;

  if (!candidates.length) {
    return { matchIndex: null, relation: "different", reason: "No candidates" };
  }

  const list = candidates.map((c, i) => `${i + 1}. ${c}`).join("\n");
  const payload = `${namespace}\nLABEL: ${label}\nCANDIDATES:\n${list}`;

  const key = cacheKey({ model, promptVersion: ADJUDICATE_VERSION, kind: "adjudicate", payload });
  const cached = readCache<Adjudication>(key);
  if (cached) return cached;

  if (!config.hasApiKey) {
    return {
      matchIndex: null,
      relation: "different",
      reason: "No provider key available for adjudication",
      fallback: true,
    };
  }

  // A key that exists but has no budget left is worse than no key at all: every
  // call still waits for a rate-limit slot before being rejected, so hundreds of
  // doomed adjudications turn a seconds-long reconcile into a many-minute one.
  // Extraction already discovers and records which models are spent; reuse that.
  if (modelChain().every(isExhausted)) {
    return {
      matchIndex: null,
      relation: "different",
      reason: "Daily quota exhausted on every configured model; not adjudicated",
      fallback: true,
    };
  }

  try {
    await getRateLimiter(config.limits).acquire(estimateTokens(PROMPTS[namespace] + list, 200));
    const { object } = await generateObject({
      model: languageModel(model),
      schema: schemaFor(namespace),
      system: PROMPTS[namespace],
      prompt: `LABEL: ${label}\n\nCANDIDATES:\n${list}`,
      temperature: 0,
    });

    const idx = Number(object.match);
    const valid = Number.isInteger(idx) && idx >= 1 && idx <= candidates.length;
    const result: Adjudication = {
      matchIndex: valid && object.relation !== "different" ? idx - 1 : null,
      relation: object.relation as AdjudicationRelation,
      reason: object.reason,
    };

    writeCache(key, result, { model, promptVersion: ADJUDICATE_VERSION });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Record a spent daily budget so the next few hundred labels skip the wait.
    if (/tokens per day|TPD|per day \(|requests per day|RPD|free_tier_requests/i.test(message)) {
      markExhausted(model);
    }
    return { matchIndex: null, relation: "different", reason: "Adjudication failed", fallback: true };
  }
}
