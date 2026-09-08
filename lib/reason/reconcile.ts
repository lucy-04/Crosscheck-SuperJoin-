/**
 * Stage 6+7 orchestration: canonicalise, block, compare, store.
 *
 * Kept separate from ingest on purpose. Ingest is per-document; reasoning is
 * corpus-wide, and separating them is what makes incremental ingest real —
 * adding a seventh PDF canonicalises only its new labels and re-reasons only the
 * blocks it actually touches, rather than rebuilding the knowledge layer.
 *
 * The cost shape is the point of the blocking step. Comparing all facts pairwise
 * is quadratic and mostly meaningless: a revenue figure and a headcount have
 * nothing to say to each other. Grouping by (canonical predicate, canonical
 * subject) first means the only pairs ever built are pairs that could possibly
 * agree or disagree.
 */

import type { Fact } from "@/lib/types";
import { canonicalize, resetRegistryCache } from "@/lib/registry/registry";
import { findRelation } from "@/lib/registry/store";
import {
  clearRelations,
  listBlocks,
  listBlockMembers,
  listUncanonicalisedFacts,
  setFactCanonical,
  upsertRelation,
} from "@/lib/db/repo";
import { compareValues } from "./compare";
import { decide, toRelation } from "./verdict";

export interface ReconcileStats {
  canonicalised: number;
  blocks: number;
  pairsCompared: number;
  relationsStored: number;
  byVerdict: Record<string, number>;
  seconds: number;
}

export interface ReconcileOptions {
  /** Discard existing relations first. Used when rules change. */
  fresh?: boolean;
  onProgress?: (phase: string, done: number, total: number) => void;
}

/**
 * Blocks larger than this compare only across documents.
 *
 * A predicate like "revenue" accumulates dozens of facts once six filings are
 * loaded, and n(n-1)/2 within one block grows fast. Cross-document pairs are also
 * the ones the assignment actually asks about, so the bound loses little.
 */
const CROSS_DOC_ONLY_ABOVE = 40;

/** Hard ceiling on pairs from a single block, so one huge block cannot stall a run. */
const MAX_PAIRS_PER_BLOCK = 1200;

export async function reconcile(opts: ReconcileOptions = {}): Promise<ReconcileStats> {
  const started = Date.now();
  const progress = opts.onProgress ?? (() => {});

  if (opts.fresh) clearRelations();
  resetRegistryCache();

  // ---- Stage 6: canonicalise -------------------------------------------
  // Only facts that have never been canonicalised, so re-running is cheap and
  // a new document does not re-resolve the whole corpus.
  const pending = listUncanonicalisedFacts();
  let canonicalised = 0;

  for (const fact of pending) {
    const predicate = await canonicalize("predicate", fact.predicate);
    const subject = await canonicalize("subject", fact.subject, fact.predicate);
    setFactCanonical(fact.id, subject.entry.id, predicate.entry.id);
    canonicalised++;
    progress("canonicalise", canonicalised, pending.length);
  }

  // ---- Stage 7: block, compare, decide ---------------------------------
  const blocks = listBlocks();
  let pairsCompared = 0;
  let relationsStored = 0;
  const byVerdict: Record<string, number> = {};

  let blockIndex = 0;
  for (const block of blocks) {
    blockIndex++;
    progress("reconcile", blockIndex, blocks.length);

    const members = listBlockMembers(block.predicateId, block.subjectId).filter(
      (f) => f.grounding === "grounded",
    );
    if (members.length < 2) continue;

    const crossDocOnly = members.length > CROSS_DOC_ONLY_ABOVE;
    let pairsInBlock = 0;

    for (let i = 0; i < members.length && pairsInBlock < MAX_PAIRS_PER_BLOCK; i++) {
      for (let j = i + 1; j < members.length && pairsInBlock < MAX_PAIRS_PER_BLOCK; j++) {
        const a = members[i];
        const b = members[j];
        if (crossDocOnly && a.documentId === b.documentId) continue;

        pairsInBlock++;
        pairsCompared++;

        const value = await compareValues(a, b);
        const decision = decide(a, b, value);

        // UNRELATED is the engine saying "these two have nothing to say to each
        // other". Storing them would bury the real findings in noise.
        if (decision.verdict === "UNRELATED") continue;

        upsertRelation(toRelation(a, b, value, decision));
        relationsStored++;
        byVerdict[decision.verdict] = (byVerdict[decision.verdict] ?? 0) + 1;
      }
    }
  }

  return {
    canonicalised,
    blocks: blocks.length,
    pairsCompared,
    relationsStored,
    byVerdict,
    seconds: Math.round((Date.now() - started) / 100) / 10,
  };
}

/**
 * Facts that relate to a given one, used by the UI's fact detail panel.
 * Reads the stored graph rather than recomputing.
 */
export function subsumptionNote(a: Fact, b: Fact): string | null {
  if (!a.canonicalPredicateId || !b.canonicalPredicateId) return null;
  const rel = findRelation(a.canonicalPredicateId, b.canonicalPredicateId, "subsumes");
  if (!rel) return null;
  return rel.direction === "a_to_b"
    ? `"${b.predicate}" is a component of "${a.predicate}"`
    : `"${a.predicate}" is a component of "${b.predicate}"`;
}
