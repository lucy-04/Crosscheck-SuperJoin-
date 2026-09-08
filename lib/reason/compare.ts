/**
 * Value comparators — one per value family, behind a single interface.
 *
 * This is what keeps the engine from being a number-cruncher. The brief asks for
 * "numerical or semantic facts", and two of its three worked examples are
 * semantic: a director active in one document and resigned in a later one, and
 * addresses written differently that mean the same place. Those need judging just
 * as much as revenue does.
 *
 * The insight that keeps this small: a number is a value valid over a period, and
 * a status is a STATE valid over a period. The scope machinery is identical for
 * both. Only the question "do these two values agree?" differs — so only that is
 * swapped out here, and `verdict.ts` never learns which kind it is looking at.
 *
 * One relation exists here that has no numeric analogue: EXCLUSIVE. Two numbers
 * are equal or they are not, but "resigned" and "in office" are not merely
 * unequal — they cannot both hold. That distinction is what lets the engine reach
 * a real verdict about a non-numeric fact.
 */

import type { Fact, ValueRelation } from "@/lib/types";
import { formatNormalized, unitsComparable } from "@/lib/normalize/units";
import { normalizeByHint } from "@/lib/normalize/text";
import { canonicalize } from "@/lib/registry/registry";
import { findRelation } from "@/lib/registry/store";

export interface ValueComparison {
  relation: ValueRelation;
  detail: string;
  /** b / a for numeric pairs. Feeds the ratio diagnostic in the explanation. */
  ratio?: number;
}

/**
 * Relative tolerance for currencies and counts. Documents round the same figure
 * differently — 8,141.7 crore in the statements against 8,142 crore in the deck
 * is one fact, not two — so exact equality would report false contradictions on
 * almost every corroborating pair.
 */
const RELATIVE_TOLERANCE = 0.005;

/**
 * Percentages get an absolute tolerance instead. A relative rule would treat
 * 11.5% and 11.6% as equal (0.9% apart relatively), but a tenth of a point is a
 * real difference in a margin, and treating it as noise would hide genuine
 * disagreements.
 */
const PERCENT_TOLERANCE = 0.051;

/** Ratios that betray a specific mistake rather than a genuine disagreement. */
const SCALE_RATIOS: { ratio: number; note: string }[] = [
  { ratio: 10, note: "exactly 10x — a scale or units mismatch, not a disagreement" },
  { ratio: 100, note: "exactly 100x — a scale or units mismatch, not a disagreement" },
  { ratio: 1000, note: "exactly 1000x — a scale or units mismatch, not a disagreement" },
  { ratio: 1e7, note: "exactly 1 crore x — a rupees-vs-crore mismatch" },
];

function compareNumbers(a: Fact, b: Fact): ValueComparison {
  const av = a.normalizedNumber;
  const bv = b.normalizedNumber;

  if (av === null || bv === null || !Number.isFinite(av) || !Number.isFinite(bv)) {
    return { relation: "UNKNOWN", detail: "One or both values could not be normalised to a number" };
  }

  const au = a.normalizedUnit ?? "";
  const bu = b.normalizedUnit ?? "";
  if (!unitsComparable(au, bu)) {
    // Refusing is the right answer: inventing an FX rate would let the engine
    // "reconcile" figures it has no basis to reconcile.
    return {
      relation: "UNKNOWN",
      detail: `Units are not comparable (${au || "none"} vs ${bu || "none"}); no conversion is attempted`,
    };
  }

  const isPercent = au === "%";
  const diff = Math.abs(av - bv);
  const scale = Math.max(Math.abs(av), Math.abs(bv));
  const same = isPercent ? diff <= PERCENT_TOLERANCE : scale === 0 ? diff === 0 : diff / scale <= RELATIVE_TOLERANCE;

  const aFmt = formatNormalized({ value: av, unit: au });
  const bFmt = formatNormalized({ value: bv, unit: bu });

  if (same) {
    return { relation: "SAME", detail: `${aFmt} matches ${bFmt}`, ratio: av === 0 ? 1 : bv / av };
  }

  const ratio = av === 0 ? Infinity : bv / av;
  let detail = `${aFmt} vs ${bFmt}`;

  for (const s of SCALE_RATIOS) {
    const r = Math.abs(ratio);
    if (Math.abs(r - s.ratio) / s.ratio < 0.005 || Math.abs(r - 1 / s.ratio) * s.ratio < 0.005) {
      detail += ` — ${s.note}`;
      break;
    }
  }

  return { relation: "DIFFERENT", detail, ratio };
}

function compareDates(a: Fact, b: Fact): ValueComparison {
  const av = a.value.kind === "date" ? a.value.iso : null;
  const bv = b.value.kind === "date" ? b.value.iso : null;
  if (!av || !bv) return { relation: "UNKNOWN", detail: "One or both dates could not be parsed" };
  return av === bv
    ? { relation: "SAME", detail: `Both state ${av}` }
    : { relation: "DIFFERENT", detail: `${av} vs ${bv}` };
}

/**
 * Text-valued comparison, routed through the registry so that the work of
 * deciding "are these the same thing?" is done once per distinct pair and reused
 * everywhere. This covers categorical states and named entities alike — the
 * difference between them is only which learned relations can apply.
 */
async function compareText(a: Fact, b: Fact): Promise<ValueComparison> {
  const araw = "raw" in a.value ? a.value.raw : "";
  const braw = "raw" in b.value ? b.value.raw : "";

  const an = normalizeByHint(araw, a.predicate);
  const bn = normalizeByHint(braw, b.predicate);

  if (an && an === bn) {
    return { relation: "SAME", detail: `Both normalise to "${an}"` };
  }

  const [ae, be] = await Promise.all([
    canonicalize("value", araw, a.predicate),
    canonicalize("value", braw, b.predicate),
  ]);

  if (ae.entry.id === be.entry.id) {
    return { relation: "SAME", detail: `Both resolve to "${ae.entry.canonical}"` };
  }

  // The learned relations are what make non-numeric reasoning possible at all.
  if (findRelation(ae.entry.id, be.entry.id, "exclusive")) {
    return {
      relation: "EXCLUSIVE",
      detail: `"${ae.entry.canonical}" and "${be.entry.canonical}" cannot both hold at once`,
    };
  }
  if (findRelation(ae.entry.id, be.entry.id, "compatible")) {
    return {
      relation: "COMPATIBLE",
      detail: `"${ae.entry.canonical}" and "${be.entry.canonical}" can both hold at once`,
    };
  }

  return {
    relation: "DIFFERENT",
    detail: `"${ae.entry.canonical}" vs "${be.entry.canonical}"`,
  };
}

/**
 * Compare two facts' values, dispatching on kind.
 *
 * Mismatched kinds are UNKNOWN rather than DIFFERENT: a number and a status are
 * not in disagreement, they are not in conversation. Reporting them as a
 * contradiction would be worse than saying nothing.
 */
export async function compareValues(a: Fact, b: Fact): Promise<ValueComparison> {
  if (a.value.kind !== b.value.kind) {
    return {
      relation: "UNKNOWN",
      detail: `Different value kinds (${a.value.kind} vs ${b.value.kind}); not comparable`,
    };
  }

  switch (a.value.kind) {
    case "number":
      return compareNumbers(a, b);
    case "date":
      return compareDates(a, b);
    default:
      return compareText(a, b);
  }
}
