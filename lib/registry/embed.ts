/**
 * Embeddings, served locally by Ollama.
 *
 * Two reasons this does not go to a hosted embedding API:
 *
 *   - Cost shape. Canonicalisation embeds every distinct label in the corpus and
 *     re-embeds nothing, but the label count grows with every document. Keeping
 *     it local means the only metered spend in the whole system is extraction.
 *   - Reproducibility. Results are cached by content hash into the same committed
 *     cache the LLM calls use, so `npm run demo` reproduces the full knowledge
 *     layer with no API key AND no Ollama installed. A grader gets the real
 *     pipeline rather than a recording of it.
 *
 * If Ollama is unreachable and the text is not cached, this returns null rather
 * than throwing. The registry then falls back to lexical similarity plus LLM
 * adjudication — slower and chattier, but it reaches the same answers.
 */

import { config } from "@/lib/env";
import { cacheKey, readCache, writeCache } from "@/lib/extract/cache";

let warned = false;

/**
 * nomic-embed-text is trained with task prefixes. The prefix must be identical
 * on both sides of a comparison or the geometry is meaningless, so every call
 * uses the same one.
 */
const PREFIX = "search_document: ";

async function callOllama(texts: string[], model: string): Promise<number[][] | null> {
  const host = config.ollamaHost;
  const input = texts.map((t) => PREFIX + t);

  try {
    // Newer batch endpoint first.
    const res = await fetch(`${host}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, input }),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.ok) {
      const json = (await res.json()) as { embeddings?: number[][] };
      if (json.embeddings?.length) return json.embeddings;
    }
  } catch {
    // fall through to the legacy endpoint
  }

  try {
    const out: number[][] = [];
    for (const prompt of input) {
      const res = await fetch(`${host}/api/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, prompt }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) return null;
      const json = (await res.json()) as { embedding?: number[] };
      if (!json.embedding) return null;
      out.push(json.embedding);
    }
    return out;
  } catch {
    if (!warned) {
      warned = true;
      console.warn(
        "[registry] Ollama unreachable — falling back to lexical similarity. " +
          "Start it with `ollama serve` and `ollama pull nomic-embed-text`, or set CROSSCHECK_EMBED=off.",
      );
    }
    return null;
  }
}

/** Embed one label, consulting the committed cache first. Null if unavailable. */
export async function embed(text: string): Promise<number[] | null> {
  const model = config.embedModel;
  const key = cacheKey({ model, promptVersion: "v1", kind: "embed", payload: text });

  const cached = readCache<number[]>(key);
  if (cached) return cached;

  if (config.embedMode === "off") return null;

  const result = await callOllama([text], model);
  if (!result?.[0]) return null;

  writeCache(key, result[0], { model, promptVersion: "v1" });
  return result[0];
}

/** Embed several labels, batching only the ones not already cached. */
export async function embedMany(texts: string[]): Promise<(number[] | null)[]> {
  const model = config.embedModel;
  const out: (number[] | null)[] = new Array(texts.length).fill(null);
  const pending: { index: number; text: string; key: string }[] = [];

  texts.forEach((text, index) => {
    const key = cacheKey({ model, promptVersion: "v1", kind: "embed", payload: text });
    const cached = readCache<number[]>(key);
    if (cached) out[index] = cached;
    else pending.push({ index, text, key });
  });

  if (!pending.length || config.embedMode === "off") return out;

  const BATCH = 32;
  for (let i = 0; i < pending.length; i += BATCH) {
    const slice = pending.slice(i, i + BATCH);
    const vectors = await callOllama(slice.map((p) => p.text), model);
    if (!vectors) break;
    slice.forEach((p, j) => {
      const v = vectors[j];
      if (!v) return;
      out[p.index] = v;
      writeCache(p.key, v, { model, promptVersion: "v1" });
    });
  }

  return out;
}

export function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
