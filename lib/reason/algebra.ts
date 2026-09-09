/**
 * The context algebra.
 *
 * Given two facts, compare them on every axis along which claims can legitimately
 * differ, and report each axis separately. This is the machinery behind the
 * project's central claim:
 *
 *     A contradiction is a failure to find a reconciling context.
 *
 * Nothing here reaches a verdict. It produces the evidence a verdict is made
 * from — one `DimensionDelta` per axis, each carrying a sentence explaining
 * itself. That is why the system can always say WHY it concluded something
 * rather than asserting it: the explanation is assembled from these, not
 * generated after the fact to justify a decision already taken.
 */

import type { DimensionDelta, Fact, PeriodRelation } from "@/lib/types";
import { comparePeriods, periodLabel, periodMonths } from "@/lib/normalize/period";
import { normalizeSubject } from "@/lib/normalize/text";
import { findRelation } from "@/lib/registry/store";

/**
 * Qualifiers that say WHICH ENTITY or slice a figure covers. Separated from other
 * basis tokens because a consolidated/standalone mismatch is a different kind of
 * explanation from a provisional/final one, and naming the right axis is the
 * whole point.
 */
const ENTITY_SCOPE = new Set(["consolidated", "standalone", "unconsolidated", "combined"]);

/**
 * A qualifier that names WHICH THING a fact is about, written "key:value" —
 * "segment:express parcel", "member:mr kapil bharati", "committee:audit".
 *
 * Distinct from consolidated/standalone, which describe the same entity measured
 * two ways. A narrowing names a DIFFERENT entity, and two facts with different
 * narrowings are not a reconcilable basis difference — they are unrelated.
 */
const isNarrowing = (b: string) => /^[a-z][\w ]*:/.test(b);
const isSegment = (b: string) => b.startsWith("segment:");

/**
 * Entity-scope qualifiers on a fact, dropping any that restrict nothing.
 *
 * A segment marker naming the SUBJECT ITSELF is a no-op: "segment:delhivery" on a
 * fact about Delhivery narrows nothing, and extractors emit these routinely when a
 * segment table repeats the parent name as a row. Left in, it makes the entity
 * scope look narrower than the figure really is, and the axis then blocks
 * comparison against the same figure stated without qualification elsewhere —
 * which suppressed a real cross-document match between the annual report and the
 * earnings deck.
 *
 * Genuine segments ("segment:express parcel") are kept, because those DO narrow.
 */
function entityScopeOf(fact: Fact): string[] {
  const subject = normalizeSubject(fact.subject);
  return fact.scope.basis
    .filter((b) => {
      if (ENTITY_SCOPE.has(b)) return true;
      if (!isNarrowing(b)) return false;
      return normalizeSubject(b.slice(b.indexOf(":") + 1)) !== subject;
    })
    .sort();
}

/**
 * Narrowing qualifiers on a fact, minus any that name the subject itself.
 * Used to detect pairs that describe different entities rather than one entity
 * measured differently.
 */
export function narrowingsOf(fact: Fact): string[] {
  const subject = normalizeSubject(fact.subject);
  return fact.scope.basis
    .filter((b) => isNarrowing(b) && normalizeSubject(b.slice(b.indexOf(":") + 1)) !== subject)
    .sort();
}

function otherBasisOf(basis: string[]): string[] {
  return basis.filter((b) => !ENTITY_SCOPE.has(b) && !isSegment(b)).sort();
}

/** Basis markers that mark a figure as superseding rather than contradicting. */
export const RESTATEMENT_MARKERS = new Set(["restated", "revised", "reinstated", "regrouped", "reclassified"]);

/** Basis markers that mark a figure as not-yet-final or forward-looking. */
export const PROVISIONAL_MARKERS = new Set([
  "provisional", "projection", "projected", "forecast", "estimate", "estimated",
  "budgeted", "preliminary", "advance",
]);

function describePeriod(rel: PeriodRelation, a: Fact, b: Fact): string {
  const al = periodLabel(a.scope.period);
  const bl = periodLabel(b.scope.period);
  switch (rel) {
    case "EQUAL":
      return `Both cover ${al}`;
    case "BOUNDARY":
      return `${al} and ${bl} — one is stated as an instant falling exactly on the other's closing date, which is how filings often head an annual column`;
    case "A_CONTAINS_B": {
      const am = a.scope.period ? periodMonths(a.scope.period) : 0;
      const bm = b.scope.period ? periodMonths(b.scope.period) : 0;
      return `${bl} sits inside ${al} (${bm} of ${am} months) — these measure different windows`;
    }
    case "B_CONTAINS_A": {
      const am = a.scope.period ? periodMonths(a.scope.period) : 0;
      const bm = b.scope.period ? periodMonths(b.scope.period) : 0;
      return `${al} sits inside ${bl} (${am} of ${bm} months) — these measure different windows`;
    }
    case "OVERLAP":
      return `${al} and ${bl} overlap but neither contains the other`;
    case "DISJOINT":
      return `${al} and ${bl} do not overlap — these describe different times`;
    case "MISSING":
      return `At least one claim carries no period (${al} vs ${bl})`;
  }
}

export interface AlgebraResult {
  deltas: DimensionDelta[];
  periodRelation: PeriodRelation;
  /** Axes that did NOT align, in the order a reader would find most explanatory. */
  misaligned: DimensionDelta[];
}

/**
 * Axis priority when naming the reason for a difference. Units come first
 * because a units mismatch makes the values incomparable outright; period next
 * because it is the most common real explanation; basis last because it is the
 * weakest signal.
 */
const AXIS_PRIORITY: DimensionDelta["dimension"][] = [
  "unit",
  "period",
  "entityScope",
  "predicate",
  "basis",
  "vintage",
];

export function computeDeltas(a: Fact, b: Fact): AlgebraResult {
  const deltas: DimensionDelta[] = [];

  // ---- period -------------------------------------------------------------
  const periodRelation = comparePeriods(a.scope.period, b.scope.period);
  deltas.push({
    dimension: "period",
    aligned: periodRelation === "EQUAL",
    a: a.scope.period ? periodLabel(a.scope.period) : null,
    b: b.scope.period ? periodLabel(b.scope.period) : null,
    note: describePeriod(periodRelation, a, b),
  });

  // ---- entity scope -------------------------------------------------------
  const aScope = entityScopeOf(a);
  const bScope = entityScopeOf(b);
  const identical = aScope.join("|") === bScope.join("|");

  // An UNSTATED entity scope is treated as compatible with a stated one, because
  // most figures in a filing are consolidated and simply do not repeat it on
  // every line. Requiring both sides to say so would stop almost every
  // cross-document pair from ever corroborating, since one source states the
  // basis in a statement heading and the other never mentions it.
  //
  // The exception is a SEGMENT, which is genuinely narrower than an unqualified
  // figure. "Express Parcel revenue" and "revenue" are different quantities, and
  // silently aligning them would manufacture agreement.
  const oneSideSilent = (!aScope.length || !bScope.length) && !identical;
  const eitherIsSegment = [...aScope, ...bScope].some(isNarrowing);
  const scopeAligned = identical || (oneSideSilent && !eitherIsSegment);

  deltas.push({
    dimension: "entityScope",
    aligned: scopeAligned,
    a: aScope.join(", ") || null,
    b: bScope.join(", ") || null,
    note: identical
      ? aScope.length
        ? `Both are ${aScope.join(", ")}`
        : "Neither declares an entity scope"
      : scopeAligned
        ? `Only one side declares an entity scope (${[...aScope, ...bScope].join(", ")}); the other is unqualified, so they are treated as compatible`
        : `Different entity scope: ${aScope.join(", ") || "unstated"} vs ${bScope.join(", ") || "unstated"} — these cover different sets of entities`,
  });

  // ---- other basis qualifiers --------------------------------------------
  const aBasis = otherBasisOf(a.scope.basis);
  const bBasis = otherBasisOf(b.scope.basis);
  const basisAligned = aBasis.join("|") === bBasis.join("|");
  deltas.push({
    dimension: "basis",
    aligned: basisAligned,
    a: aBasis.join(", ") || null,
    b: bBasis.join(", ") || null,
    note: basisAligned
      ? aBasis.length
        ? `Both are ${aBasis.join(", ")}`
        : "Neither carries additional qualifiers"
      : `Different basis: ${aBasis.join(", ") || "none"} vs ${bBasis.join(", ") || "none"}`,
  });

  // ---- unit ---------------------------------------------------------------
  const au = a.normalizedUnit;
  const bu = b.normalizedUnit;
  const unitAligned = au === bu;
  deltas.push({
    dimension: "unit",
    aligned: unitAligned,
    a: au,
    b: bu,
    note: unitAligned
      ? au
        ? `Both normalise to ${au}`
        : "Neither is a measured quantity"
      : `Units do not reduce to a common base (${au ?? "none"} vs ${bu ?? "none"})`,
  });

  // ---- predicate ----------------------------------------------------------
  // Blocking already matched the canonical predicate, so a mismatch here means a
  // learned subsumption edge brought the pair together deliberately.
  const samePredicate = a.canonicalPredicateId === b.canonicalPredicateId;
  let predicateNote = samePredicate
    ? `Both measure "${a.predicate}"`
    : `Different measures: "${a.predicate}" vs "${b.predicate}"`;
  if (!samePredicate && a.canonicalPredicateId && b.canonicalPredicateId) {
    const sub = findRelation(a.canonicalPredicateId, b.canonicalPredicateId, "subsumes");
    if (sub) {
      const [broad, narrow] =
        sub.direction === "a_to_b" ? [a.predicate, b.predicate] : [b.predicate, a.predicate];
      predicateNote = `"${narrow}" is a component of "${broad}" — one is part of the other, so a gap between them is expected`;
    }
  }
  deltas.push({
    dimension: "predicate",
    aligned: samePredicate,
    a: a.predicate,
    b: b.predicate,
    note: predicateNote,
  });

  // ---- vintage ------------------------------------------------------------
  // Not a scope difference but a recency one: when two sources disagree, which
  // is the later word? This is what separates a superseded figure or a changed
  // state from a genuine conflict.
  const av = a.scope.assertedAsOf;
  const bv = b.scope.assertedAsOf;
  const vintageAligned = av === bv;
  deltas.push({
    dimension: "vintage",
    aligned: vintageAligned,
    a: av,
    b: bv,
    note:
      !av || !bv
        ? "At least one source has no publication date"
        : vintageAligned
          ? `Both were published ${av}`
          : `Published ${av} and ${bv} — ${av < bv ? "the second" : "the first"} is the later statement`,
  });

  const misaligned = deltas
    .filter((d) => !d.aligned)
    .sort((x, y) => AXIS_PRIORITY.indexOf(x.dimension) - AXIS_PRIORITY.indexOf(y.dimension));

  return { deltas, periodRelation, misaligned };
}

/** Which side, if either, is explicitly marked as a restatement of the other. */
export function restatementSide(a: Fact, b: Fact): "a" | "b" | null {
  const aMarked = a.scope.basis.some((x) => RESTATEMENT_MARKERS.has(x));
  const bMarked = b.scope.basis.some((x) => RESTATEMENT_MARKERS.has(x));
  if (aMarked && !bMarked) return "a";
  if (bMarked && !aMarked) return "b";
  return null;
}

/** Which side, if either, is a projection or provisional figure. */
export function provisionalSide(a: Fact, b: Fact): "a" | "b" | null {
  const aMarked = a.scope.basis.some((x) => PROVISIONAL_MARKERS.has(x));
  const bMarked = b.scope.basis.some((x) => PROVISIONAL_MARKERS.has(x));
  if (aMarked && !bMarked) return "a";
  if (bMarked && !aMarked) return "b";
  return null;
}

/** The later-published side, when both carry a date. */
export function laterSide(a: Fact, b: Fact): "a" | "b" | null {
  const av = a.scope.assertedAsOf;
  const bv = b.scope.assertedAsOf;
  if (!av || !bv || av === bv) return null;
  return av > bv ? "a" : "b";
}
