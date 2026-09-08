/**
 * Unit and scale normalisation.
 *
 * The same quantity appears as "8,141.7" under a "Rs. in crore" heading in one
 * document and as "81,417" under "INR millions" in another. Those are the same
 * fact. Until both are expressed in one base unit, the reconciliation engine
 * would call them a contradiction — the single most embarrassing failure this
 * system could have, since it is the exact example the brief opens with.
 *
 * Deliberate non-goal: currency conversion. The IMF reports in USD billions and
 * the RBI in INR crore. Inventing an FX rate would manufacture false precision
 * and let the engine "reconcile" things it has no business reconciling, so
 * cross-currency pairs are reported as an unresolved `unit` axis instead. Saying
 * "I cannot compare these" is a better answer than a confident wrong one.
 */

import type { NumberValue } from "@/lib/types";

/** Multiplier words, including the South Asian scales Western parsers miss. */
export const SCALES: Record<string, number> = {
  hundred: 1e2,
  thousand: 1e3,
  k: 1e3,
  lakh: 1e5,
  lac: 1e5,
  lakhs: 1e5,
  lacs: 1e5,
  million: 1e6,
  millions: 1e6,
  mn: 1e6,
  mln: 1e6,
  m: 1e6,
  crore: 1e7,
  crores: 1e7,
  cr: 1e7,
  billion: 1e9,
  billions: 1e9,
  bn: 1e9,
  b: 1e9,
  "lakh crore": 1e12,
  "lac crore": 1e12,
  trillion: 1e12,
  tn: 1e12,
  tr: 1e12,
};

/** Symbols and codes that denote a currency, mapped to an ISO-ish code. */
const CURRENCY_ALIASES: Record<string, string> = {
  "₹": "INR",
  rs: "INR",
  "rs.": "INR",
  inr: "INR",
  rupees: "INR",
  rupee: "INR",
  $: "USD",
  us$: "USD",
  usd: "USD",
  dollars: "USD",
  "€": "EUR",
  eur: "EUR",
  "£": "GBP",
  gbp: "GBP",
};

/**
 * Non-currency unit families, normalised to a base. Percentages and basis points
 * are the pair that actually bites: a 25 bps change and a 0.25% change are the
 * same claim written two ways, and central-bank documents mix them constantly.
 */
const UNIT_BASE: Record<string, { base: string; factor: number }> = {
  "%": { base: "%", factor: 1 },
  percent: { base: "%", factor: 1 },
  percentage: { base: "%", factor: 1 },
  pct: { base: "%", factor: 1 },
  "per cent": { base: "%", factor: 1 },
  bps: { base: "%", factor: 0.01 },
  bp: { base: "%", factor: 0.01 },
  "basis points": { base: "%", factor: 0.01 },
  "percentage points": { base: "%", factor: 1 },
  pp: { base: "%", factor: 1 },
  days: { base: "days", factor: 1 },
  day: { base: "days", factor: 1 },
  months: { base: "months", factor: 1 },
  years: { base: "years", factor: 1 },
  count: { base: "count", factor: 1 },
  units: { base: "count", factor: 1 },
  tonnes: { base: "kg", factor: 1000 },
  tonne: { base: "kg", factor: 1000 },
  mt: { base: "kg", factor: 1000 },
  kg: { base: "kg", factor: 1 },
  km: { base: "m", factor: 1000 },
  m2: { base: "m2", factor: 1 },
  "sq ft": { base: "m2", factor: 0.092903 },
  sqft: { base: "m2", factor: 0.092903 },
};

const clean = (s: string | null | undefined) =>
  (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Parse a printed numeric literal. Handles Indian digit grouping ("1,23,456.78"),
 * accounting negatives ("(1,234)"), and stray currency symbols left on the token.
 */
export function parseNumericLiteral(raw: string): number | null {
  if (!raw) return null;
  const s = raw.trim();

  // Locate the numeric token rather than deleting everything around it. Deleting
  // is fragile: stripping "Rs." out of "Rs. 2,194" leaves a leading ".", and
  // ".2194" parses cleanly as a wrong answer — a silent three-orders-of-magnitude
  // error that no later stage could detect.
  const m = s.match(/\d[\d,]*(?:\.\d+)?|\.\d+/);
  if (!m || m.index === undefined) return null;

  // Strip grouping separators regardless of placement — Indian grouping is not
  // every-three-digits, so a positional rule would silently corrupt lakhs.
  const digits = m[0].replace(/,/g, "");
  const n = parseFloat(digits);
  if (!Number.isFinite(n)) return null;

  // Negative either as a sign directly before the number, or accounting-style
  // parentheses wrapped around it.
  const before = s.slice(0, m.index);
  const negated = /-\s*$/.test(before) || (/\(/.test(before) && /\)/.test(s.slice(m.index)));

  return negated ? -n : n;
}

export interface NormalizedNumber {
  /** Magnitude in the base unit — rupees, percent, kilograms, plain count. */
  value: number;
  /** Base unit label. Currencies keep their code so they are never cross-compared. */
  unit: string;
}

/**
 * Collapse a NumberValue to a single comparable magnitude.
 *
 * Returns null only when the literal itself is unparseable. An unrecognised unit
 * is NOT a failure — it passes through as its own base, so a document inventing
 * a unit we have never seen still produces comparable facts among its own kind.
 */
export function normalizeNumber(v: NumberValue): NormalizedNumber | null {
  const magnitude = Number.isFinite(v.number) ? v.number : parseNumericLiteral(v.raw);
  if (magnitude === null || !Number.isFinite(magnitude)) return null;

  const scaleKey = clean(v.scale);
  const scale = scaleKey ? (SCALES[scaleKey] ?? 1) : 1;

  const unitKey = clean(v.unit);
  const currencyKey = clean(v.currency) || unitKey;

  // Currency: base unit is the smallest denomination the document speaks in
  // (rupees, dollars), and the scale word is folded into the magnitude.
  const currency = CURRENCY_ALIASES[currencyKey];
  if (currency) {
    return { value: magnitude * scale, unit: currency };
  }

  const known = UNIT_BASE[unitKey];
  if (known) {
    return { value: magnitude * scale * known.factor, unit: known.base };
  }

  // Unknown or absent unit: keep the scale, keep whatever label was given.
  return { value: magnitude * scale, unit: unitKey || "count" };
}

/**
 * Whether two normalised units may be compared at all. Cross-currency returns
 * false by design — see the module note.
 */
export function unitsComparable(a: string, b: string): boolean {
  return a === b;
}

/** Human-readable magnitude for explanations, using the scale the reader expects. */
export function formatNormalized(n: NormalizedNumber): string {
  const { value, unit } = n;
  if (unit === "INR") {
    const abs = Math.abs(value);
    if (abs >= 1e7) return `₹${(value / 1e7).toLocaleString("en-IN", { maximumFractionDigits: 2 })} crore`;
    if (abs >= 1e5) return `₹${(value / 1e5).toLocaleString("en-IN", { maximumFractionDigits: 2 })} lakh`;
    return `₹${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
  }
  if (unit === "%") return `${value.toLocaleString("en-US", { maximumFractionDigits: 3 })}%`;
  return `${value.toLocaleString("en-US", { maximumFractionDigits: 3 })} ${unit}`.trim();
}
