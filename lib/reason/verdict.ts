/**
 * The verdict rules.
 *
 * An ordered, total decision table over (value comparison x context algebra).
 * Every rule is named, every verdict records which rule produced it, and every
 * explanation is assembled from the deltas that drove it — so a reader can
 * always retrace why the system concluded what it did.
 *
 * The rules are value-kind agnostic. That is the design's payoff, and it is
 * easiest to see in the brief's own director example:
 *
 *     "in office" (2022 prospectus) vs "resigned" (FY24 report)
 *       -> compareValues returns EXCLUSIVE
 *       -> the vintage axis is misaligned
 *       -> R4 fires: SUPERSEDED, "the state changed between these two documents"
 *
 * while two documents of the SAME vintage making those two claims would fall
 * through to R5 and be reported as a genuine contradiction. Same table, no
 * special-casing for non-numeric facts anywhere.
 */

import type { DimensionDelta, Fact, Relation, Verdict } from "@/lib/types";
import type { ValueComparison } from "./compare";
import { computeDeltas, laterSide, provisionalSide, restatementSide } from "./algebra";

export interface VerdictResult {
  verdict: Verdict;
  ruleId: string;
  axis: DimensionDelta["dimension"] | null;
  confidence: number;
  explanation: string;
  deltas: DimensionDelta[];
}

/** Axes that must agree before two values are even in conversation. */
const CORE_AXES: DimensionDelta["dimension"][] = ["period", "entityScope", "basis", "unit", "predicate"];

function coreMisaligned(deltas: DimensionDelta[]): DimensionDelta[] {
  return deltas.filter((d) => CORE_AXES.includes(d.dimension) && !d.aligned);
}

const label = (f: Fact) =>
  `${f.subject} · ${f.predicate}${f.scope.period ? ` (${f.scope.period.raw})` : ""}`;

/**
 * Confidence blends how sure the extractor was about each side with how clean the
 * decision was. A verdict resting on a shaky extraction should not be presented
 * as firmly as one resting on two confident ones.
 */
function confidenceFor(a: Fact, b: Fact, base: number): number {
  const extraction = Math.min(a.extractionConfidence, b.extractionConfidence);
  return Math.round(Math.min(1, base * (0.6 + 0.4 * extraction)) * 100) / 100;
}

export function decide(a: Fact, b: Fact, value: ValueComparison): VerdictResult {
  const { deltas } = computeDeltas(a, b);
  const misaligned = coreMisaligned(deltas);
  const aligned = misaligned.length === 0;

  const vintage = deltas.find((d) => d.dimension === "vintage")!;
  const restated = restatementSide(a, b);
  const provisional = provisionalSide(a, b);
  const later = laterSide(a, b);

  const mk = (
    verdict: Verdict,
    ruleId: string,
    axis: DimensionDelta["dimension"] | null,
    base: number,
    explanation: string,
  ): VerdictResult => ({
    verdict,
    ruleId,
    axis,
    confidence: confidenceFor(a, b, base),
    explanation,
    deltas,
  });

  // ---- R0: the values were never comparable -------------------------------
  if (value.relation === "UNKNOWN") {
    // A units mismatch is a real, nameable reason two figures cannot be set
    // against each other — worth surfacing rather than discarding.
    const unitDelta = deltas.find((d) => d.dimension === "unit");
    if (unitDelta && !unitDelta.aligned) {
      return mk(
        "RECONCILED",
        "R0-units",
        "unit",
        0.6,
        `Not comparable as stated. ${value.detail}. ${unitDelta.note}. No conversion is attempted, because inventing one would manufacture agreement that the documents do not support.`,
      );
    }
    return mk("UNRELATED", "R0", null, 0.2, value.detail);
  }

  // ---- R1: agreement on aligned scope -------------------------------------
  if (value.relation === "SAME" && aligned) {
    return mk(
      "CORROBORATES",
      "R1",
      null,
      0.95,
      `Both sources state the same value for the same scope. ${value.detail}. ` +
        `${deltas.find((d) => d.dimension === "period")!.note}, and every other axis agrees.`,
    );
  }

  // ---- R2: same value, different scope ------------------------------------
  // Not a disagreement and not a corroboration — two different facts that happen
  // to coincide. Reported weakly so it does not crowd out real findings.
  if (value.relation === "SAME") {
    return mk(
      "UNRELATED",
      "R2",
      misaligned[0].dimension,
      0.3,
      `Same value but different scope, so this is coincidence rather than corroboration. ${misaligned[0].note}.`,
    );
  }

  // ---- R3: values can both hold ------------------------------------------
  if (value.relation === "COMPATIBLE") {
    return mk(
      "CORROBORATES",
      "R3",
      null,
      0.7,
      `These do not conflict. ${value.detail}.`,
    );
  }

  // From here the values genuinely differ or are mutually exclusive.
  const differing = value.relation === "DIFFERENT" || value.relation === "EXCLUSIVE";

  // ---- R4: a scope difference explains the gap ----------------------------
  if (differing && !aligned) {
    const axis = misaligned[0];
    return mk(
      "RECONCILED",
      `R4-${axis.dimension}`,
      axis.dimension,
      0.85,
      `These look contradictory but are not: they describe different things. ${axis.note}. ` +
        `Values: ${value.detail}.` +
        (misaligned.length > 1
          ? ` Also differing: ${misaligned.slice(1).map((d) => d.dimension).join(", ")}.`
          : ""),
    );
  }

  // ---- R5: one figure explicitly restates the other -----------------------
  if (differing && restated) {
    const [newer, older] = restated === "a" ? [a, b] : [b, a];
    return mk(
      "SUPERSEDED",
      "R5-restated",
      "basis",
      0.9,
      `Not a contradiction: ${label(newer)} is explicitly marked as restated, so it replaces ` +
        `${label(older)} rather than disagreeing with it. Values: ${value.detail}.`,
    );
  }

  // ---- R6: a state that changed between two documents ---------------------
  // The brief's own example. Two mutually exclusive states asserted by sources of
  // different vintage is a change over time, not a conflict.
  if (value.relation === "EXCLUSIVE" && later) {
    const [newer, older] = later === "a" ? [a, b] : [b, a];
    return mk(
      "SUPERSEDED",
      "R6-state-changed",
      "vintage",
      0.85,
      `The state changed between these documents rather than the sources disagreeing. ` +
        `${label(older)} was published ${older.scope.assertedAsOf}; ${label(newer)} was published ` +
        `${newer.scope.assertedAsOf} and is the later position. ${value.detail}.`,
    );
  }

  // ---- R7: a projection against an actual ---------------------------------
  if (differing && provisional) {
    const [est, actual] = provisional === "a" ? [a, b] : [b, a];
    return mk(
      "RECONCILED",
      "R7-provisional",
      "basis",
      0.8,
      `One of these is not a settled figure: ${label(est)} is marked ` +
        `${est.scope.basis.join(", ")}, while ${label(actual)} is stated without that qualifier. ` +
        `A projection differing from an outturn is expected. Values: ${value.detail}.`,
    );
  }

  // ---- R7b: several values under one label on a single page ---------------
  //
  // A page that prints
  //     Employee benefits    34.1%
  //     Freight              18.8%
  //     Technology           12.2%
  // under the heading "as % of revenue" is a BREAKDOWN, not four sources
  // disagreeing. When the extractor gives each row the same generic predicate,
  // the rows land in one block with identical scope and different values, and
  // every reconciling axis genuinely does align — so the rules above would call
  // each row a contradiction of every other. Twenty-eight of them, on one page,
  // in the first real run.
  //
  // Contradiction requires two INDEPENDENT assertions about the same thing. Two
  // numbers printed on one page under one label are components of a whole, and
  // the honest report is that the predicate failed to distinguish them.
  if (differing && a.documentId === b.documentId && a.evidence.pageNumber === b.evidence.pageNumber) {
    return mk(
      "UNRELATED",
      "R7b-same-page-breakdown",
      "predicate",
      0.25,
      `Both values sit on the same page of the same document under the measure ` +
        `"${a.predicate}", which means this is one table's breakdown rather than two ` +
        `sources disagreeing. The extracted measure does not distinguish the rows, so no ` +
        `verdict is claimed. ${value.detail}.`,
    );
  }

  // ---- R8: genuine disagreement -------------------------------------------
  // Every reconciling hypothesis has been tried and none fits.
  const vintageNote = vintage.aligned
    ? ""
    : ` Note that ${vintage.note.toLowerCase()}; neither document marks the figure as restated, ` +
      `so this may be an unflagged revision rather than an error.`;

  return mk(
    "CONTRADICTS",
    "R8",
    null,
    vintage.aligned ? 0.9 : 0.7,
    `Genuine disagreement. Both describe the same subject, measure, period, entity scope, basis ` +
      `and unit, yet ${value.relation === "EXCLUSIVE" ? "assert states that cannot both hold" : "state different values"}. ` +
      `${value.detail}.${vintageNote}`,
  );
}

/** Assemble the stored relation record from a decision. */
export function toRelation(
  a: Fact,
  b: Fact,
  value: ValueComparison,
  decision: VerdictResult,
  decidedBy: "rule" | "llm" = "rule",
): Omit<Relation, "id"> {
  return {
    factAId: a.id,
    factBId: b.id,
    verdict: decision.verdict,
    confidence: decision.confidence,
    axis: decision.axis,
    valueRelation: value.relation,
    deltas: decision.deltas,
    explanation: decision.explanation,
    decidedBy,
    ruleId: decision.ruleId,
  };
}
