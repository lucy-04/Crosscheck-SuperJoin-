/**
 * The vocabulary registry: one canonicaliser, three namespaces.
 *
 * Subjects, predicates and categorical values all face the same problem — the
 * same thing written differently must resolve to one identity, and things that
 * merely look alike must not. So they share one pipeline, parameterised by
 * namespace:
 *
 *     normalise  ->  exact match?     -> decided, free
 *                ->  lexically close? -> decided, free
 *                ->  embed, shortlist -> LLM adjudicates -> decided, cached
 *                ->  nothing close    -> mint a new canonical entry
 *
 * The ordering matters. Embeddings shortlist but never decide (see adjudicate.ts
 * for the measurements that forced this). Cheap deterministic checks resolve the
 * common cases so the expensive one runs rarely, and because entries persist,
 * each distinct label is adjudicated once for the life of the corpus.
 */

import { normalizeByHint, normalizeSubject, normalizeText, textSimilarity } from "@/lib/normalize/text";
import { cosine, embed } from "./embed";
import { adjudicateAgainst } from "./adjudicate";
import {
  addAlias,
  addRelation,
  createEntry,
  findByNormalized,
  listEntries,
  type Namespace,
  type RegistryEntry,
} from "./store";

/** Lexical similarity above this is treated as the same label without asking. */
const LEXICAL_SAME = 0.92;

/**
 * Cosine floor for entering the shortlist. Set from measured data: genuinely
 * unrelated financial labels sit around 0.62-0.70, so 0.72 admits real candidates
 * without flooding the adjudicator. Pairs below it are handled by the
 * normalisers' alias lexicons instead.
 */
const SHORTLIST_FLOOR = 0.72;

/** How many candidates the adjudicator is asked about, most similar first. */
const SHORTLIST_SIZE = 3;

export type Decision = "exact" | "lexical" | "adjudicated" | "new";

export interface CanonicalizeResult {
  entry: RegistryEntry;
  decision: Decision;
  /** Set when adjudication established a relation rather than sameness. */
  note?: string;
}

/** In-process cache of entries per namespace, refreshed as entries are minted. */
const cache = new Map<Namespace, RegistryEntry[]>();

function entriesFor(namespace: Namespace): RegistryEntry[] {
  let list = cache.get(namespace);
  if (!list) {
    list = listEntries(namespace);
    cache.set(namespace, list);
  }
  return list;
}

function remember(entry: RegistryEntry): void {
  const list = entriesFor(entry.namespace);
  list.push(entry);
}

/** Drop the in-process cache — used by scripts between runs. */
export function resetRegistryCache(): void {
  cache.clear();
}

function normalizeFor(namespace: Namespace, label: string, hint?: string): string {
  if (namespace === "predicate") return normalizeText(label);

  // Subjects get a dedicated normaliser rather than predicate-derived routing.
  // Blocking is keyed on the canonical subject, so folding "Delhivery" and
  // "Delhivery Limited" differently would put their facts in separate blocks and
  // they would never be compared — silently losing the cross-document
  // corroboration this system exists to surface.
  if (namespace === "subject") return normalizeSubject(label);

  // Values ARE routed by their predicate, which is a reliable signal for them:
  // "registered office address" says to fold an address, "name of director" says
  // to fold a person's name.
  return normalizeByHint(label, hint ?? "");
}

/**
 * Resolve a label to a canonical registry entry, creating one if nothing matches.
 */
export async function canonicalize(
  namespace: Namespace,
  label: string,
  hint?: string,
): Promise<CanonicalizeResult> {
  const canonical = label.trim();
  const normalized = normalizeFor(namespace, canonical, hint);

  if (!normalized) {
    // An empty normalisation still needs an identity, or every blank label would
    // collide into one block. Fall back to the raw string.
    const entry = findByNormalized(namespace, canonical) ?? createEntry({ namespace, canonical, normalized: canonical, embedding: null });
    return { entry, decision: "exact" };
  }

  // ---- 1. Exact match on the normalised form ------------------------------
  const exact = findByNormalized(namespace, normalized);
  if (exact) {
    addAlias(exact.id, canonical);
    return { entry: exact, decision: "exact" };
  }

  const existing = entriesFor(namespace);

  // ---- 2. Lexically almost identical --------------------------------------
  let bestLexical: { entry: RegistryEntry; score: number } | null = null;
  for (const entry of existing) {
    const score = textSimilarity(normalized, entry.normalized);
    if (!bestLexical || score > bestLexical.score) bestLexical = { entry, score };
  }
  if (bestLexical && bestLexical.score >= LEXICAL_SAME) {
    addAlias(bestLexical.entry.id, canonical);
    return { entry: bestLexical.entry, decision: "lexical" };
  }

  // ---- 3. Embed, shortlist, adjudicate ------------------------------------
  const vector = await embed(normalized);

  if (vector && existing.length) {
    const shortlist = existing
      .filter((e) => e.embedding)
      .map((e) => ({ entry: e, score: cosine(vector, e.embedding!) }))
      .filter((c) => c.score >= SHORTLIST_FLOOR)
      .sort((a, b) => b.score - a.score)
      .slice(0, SHORTLIST_SIZE);

    if (shortlist.length) {
      // One call for the whole shortlist — see adjudicate.ts for why.
      const verdict = await adjudicateAgainst(
        namespace,
        canonical,
        shortlist.map((c) => c.entry.canonical),
      );

      const matched = verdict.matchIndex === null ? null : shortlist[verdict.matchIndex]?.entry;

      if (matched && verdict.relation === "same") {
        addAlias(matched.id, canonical);
        return { entry: matched, decision: "adjudicated", note: verdict.reason };
      }

      // Not the same thing, but relatable. Mint a distinct entry and record how
      // it relates — this is what lets the engine treat a component-vs-aggregate
      // gap as reconcilable rather than contradictory.
      if (matched && verdict.relation !== "different") {
        const entry = createEntry({ namespace, canonical, normalized, embedding: vector });
        remember(entry);

        if (verdict.relation === "a_broader_than_b") {
          addRelation({ namespace, aId: entry.id, bId: matched.id, kind: "subsumes" });
        } else if (verdict.relation === "b_broader_than_a") {
          addRelation({ namespace, aId: matched.id, bId: entry.id, kind: "subsumes" });
        } else if (verdict.relation === "exclusive") {
          addRelation({ namespace, aId: entry.id, bId: matched.id, kind: "exclusive" });
        } else if (verdict.relation === "compatible") {
          addRelation({ namespace, aId: entry.id, bId: matched.id, kind: "compatible" });
        }

        return { entry, decision: "adjudicated", note: verdict.reason };
      }
    }
  }

  // ---- 4. Nothing close: the vocabulary grows -----------------------------
  const entry = createEntry({ namespace, canonical, normalized, embedding: vector });
  remember(entry);
  return { entry, decision: "new" };
}
