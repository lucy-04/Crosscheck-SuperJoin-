/**
 * Period normalisation.
 *
 * Documents write time in a dozen incompatible ways: "FY24", "FY2023-24",
 * "2023-24", "Q4FY24", "H1 FY25", "9M FY24", "as at March 31, 2024", "CY2024".
 * Comparing those as strings is hopeless. Comparing them as intervals is easy.
 *
 * So every period collapses to an inclusive [start, end] pair of ISO dates, and
 * every question the reconciliation engine asks about time ("is one inside the
 * other?", "do these overlap?") becomes interval arithmetic.
 *
 * The fiscal-year start month is a parameter, not a constant. India's April-March
 * convention is the default because the starter documents use it, but a US 10-K
 * (October) or an Australian report (July) only needs a different option — the
 * document set does not have to look like the one this was built against.
 */

import type { Period, PeriodKind, PeriodRelation } from "@/lib/types";

export interface PeriodOptions {
  /** Month (1-12) a fiscal year begins in. 4 = India's April-March year. */
  fiscalYearStartMonth?: number;
}

const DEFAULT_FY_START = 4;

const MONTHS: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/** Last calendar day of month `m` (1-based) in year `y`. */
function lastDay(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function addMonths(y: number, m: number, delta: number): { y: number; m: number } {
  const zero = y * 12 + (m - 1) + delta;
  return { y: Math.floor(zero / 12), m: (zero % 12) + 1 };
}

/**
 * Expand a written year to four digits. Documents mix "FY24" and "FY2024" freely,
 * sometimes on the same page.
 */
function expandYear(raw: string): number {
  const n = parseInt(raw, 10);
  if (raw.length === 4) return n;
  return n >= 70 ? 1900 + n : 2000 + n;
}

/**
 * The span of the fiscal year *labelled* `label`.
 *
 * Convention: a fiscal year is named for the calendar year it ENDS in, which is
 * what "FY24 = April 2023 to March 2024" means. When the fiscal year starts in
 * January the label and the calendar year coincide.
 */
function fiscalYearSpan(label: number, startMonth: number): { start: string; end: string } {
  if (startMonth === 1) {
    return { start: iso(label, 1, 1), end: iso(label, 12, 31) };
  }
  const endMonth = startMonth - 1;
  return {
    start: iso(label - 1, startMonth, 1),
    end: iso(label, endMonth, lastDay(label, endMonth)),
  };
}

/** A window of `lengthMonths` starting `offsetMonths` into fiscal year `label`. */
function fiscalWindow(
  label: number,
  startMonth: number,
  offsetMonths: number,
  lengthMonths: number,
): { start: string; end: string } {
  const fyStartYear = startMonth === 1 ? label : label - 1;
  const s = addMonths(fyStartYear, startMonth, offsetMonths);
  const eExclusive = addMonths(fyStartYear, startMonth, offsetMonths + lengthMonths);
  const e = addMonths(eExclusive.y, eExclusive.m, -1);
  return { start: iso(s.y, s.m, 1), end: iso(e.y, e.m, lastDay(e.y, e.m)) };
}

function make(raw: string, kind: PeriodKind, span: { start: string; end: string }): Period {
  return { raw: raw.trim(), kind, start: span.start, end: span.end };
}

/**
 * Parse a written period into an interval. Returns null when the string carries
 * no recoverable time information — the caller treats that as "unscoped", which
 * is itself meaningful: an unscoped fact cannot be contradicted, only flagged.
 */
export function parsePeriod(input: string | null | undefined, opts: PeriodOptions = {}): Period | null {
  if (!input) return null;
  const fyStart = opts.fiscalYearStartMonth ?? DEFAULT_FY_START;

  const raw = input.trim();
  if (!raw) return null;

  // Lower-cased, punctuation-flattened working copy. "F.Y. 2023-24" -> "fy 2023-24".
  const s = raw
    .toLowerCase()
    .replace(/f\.?\s*y\.?/g, "fy")
    .replace(/[‐-―−]/g, "-") // unicode dashes -> hyphen
    .replace(/\s+/g, " ")
    .trim();

  // ---- Quarters: "Q4FY24", "Q4 FY2023-24", "fourth quarter of FY24" ----------
  const q = s.match(/\bq([1-4])\s*(?:of\s*)?(?:fy)?\s*'?(\d{4}|\d{2})(?:\s*-\s*\d{2,4})?/);
  if (q) {
    const label = fyLabelFrom(q[2], s);
    return make(raw, "quarter", fiscalWindow(label, fyStart, (parseInt(q[1], 10) - 1) * 3, 3));
  }

  // ---- Halves: "H1FY25", "first half of FY25" -------------------------------
  const h = s.match(/\bh([12])\s*(?:of\s*)?(?:fy)?\s*'?(\d{4}|\d{2})(?:\s*-\s*\d{2,4})?/);
  if (h) {
    const label = fyLabelFrom(h[2], s);
    return make(raw, "half_year", fiscalWindow(label, fyStart, (parseInt(h[1], 10) - 1) * 6, 6));
  }

  // ---- Cumulative windows: "9M FY24", "6M FY25" -----------------------------
  const cum = s.match(/\b(\d{1,2})\s*m\s*(?:of\s*)?(?:fy)?\s*'?(\d{4}|\d{2})/);
  if (cum) {
    const months = parseInt(cum[1], 10);
    if (months >= 1 && months <= 12) {
      const label = fyLabelFrom(cum[2], s);
      return make(raw, "range", fiscalWindow(label, fyStart, 0, months));
    }
  }

  // ---- Explicit instants: "as at March 31, 2024", "31-03-2024", "2024-03-31" -
  const instant = parseInstant(s);
  if (instant) {
    // "year ended March 31, 2024" names a year, not the day it closed on.
    if (/\b(year|yr)\s+(ended|ending|end)\b/.test(s)) {
      const [y, m] = instant.split("-").map(Number);
      const label = m >= fyStart && fyStart !== 1 ? y + 1 : y;
      return make(raw, "fiscal_year", fiscalYearSpan(label, fyStart));
    }
    return make(raw, "instant", { start: instant, end: instant });
  }

  // ---- Calendar year: "CY2024", "calendar year 2024" ------------------------
  const cy = s.match(/\b(?:cy|calendar\s+year)\s*'?(\d{4}|\d{2})/);
  if (cy) {
    const y = expandYear(cy[1]);
    return make(raw, "calendar_year", { start: iso(y, 1, 1), end: iso(y, 12, 31) });
  }

  // ---- Fiscal year, spanning form: "FY2023-24", "2023-24", "FY2024/25" ------
  const span = s.match(/\b(?:fy)?\s*'?(\d{4})\s*[-/]\s*(\d{2,4})\b/);
  if (span) {
    const first = parseInt(span[1], 10);
    // "2023-24" names the fiscal year ending 2024 — i.e. label = first + 1.
    return make(raw, "fiscal_year", fiscalYearSpan(first + 1, fyStart));
  }

  // ---- Fiscal year, single form: "FY24", "FY 2024" --------------------------
  const fy = s.match(/\bfy\s*'?(\d{4}|\d{2})\b/);
  if (fy) {
    return make(raw, "fiscal_year", fiscalYearSpan(expandYear(fy[1]), fyStart));
  }

  // ---- A bare four-digit year, only if the string is essentially just that ---
  const bare = s.match(/^(?:in\s+|for\s+)?(\d{4})$/);
  if (bare) {
    const y = parseInt(bare[1], 10);
    if (y >= 1900 && y <= 2100) {
      return make(raw, "calendar_year", { start: iso(y, 1, 1), end: iso(y, 12, 31) });
    }
  }

  return null;
}

/**
 * A fiscal-year label written next to a quarter may be "24", "2024" or the first
 * half of a "2023-24" span. Disambiguate using the surrounding text.
 */
function fyLabelFrom(token: string, context: string): number {
  const y = expandYear(token);
  // "Q4 FY2023-24" gives token "2023" but names the year ending 2024.
  if (token.length === 4 && /\d{4}\s*-\s*\d{2,4}/.test(context)) return y + 1;
  return y;
}

/** Recognise a single calendar date in any of the common written forms. */
function parseInstant(s: string): string | null {
  // ISO first: 2024-03-31
  const isoM = s.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (isoM) return iso(+isoM[1], +isoM[2], +isoM[3]);

  // "31 March 2024" / "31st March, 2024"
  const dmy = s.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+),?\s+(\d{4})\b/);
  if (dmy && MONTHS[dmy[2]]) return iso(+dmy[3], MONTHS[dmy[2]], +dmy[1]);

  // "March 31, 2024" / "March 31 2024"
  const mdy = s.match(/\b([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/);
  if (mdy && MONTHS[mdy[1]]) return iso(+mdy[3], MONTHS[mdy[1]], +mdy[2]);

  // "31/03/2024" or "31-03-2024" — day-first, the Indian and British convention.
  const num = s.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/);
  if (num) {
    const d = +num[1];
    const m = +num[2];
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) return iso(+num[3], m, d);
  }

  return null;
}

/**
 * How two intervals relate. This is the vocabulary reconciliation explanations
 * are written in — "Q4 FY2024 sits inside FY2024" is A_CONTAINS_B, and that
 * single fact is what turns an apparent contradiction into a reconciliation.
 */
export function comparePeriods(a: Period | null, b: Period | null): PeriodRelation {
  if (!a || !b) return "MISSING";
  if (a.start === b.start && a.end === b.end) return "EQUAL";

  // An instant sitting exactly on the other period's closing date.
  //
  // Financial statements routinely head an annual column with its closing date
  // ("March 31, 2024") rather than naming the year, so the same figure appears
  // as an instant in one document and as a fiscal year in another. Which is
  // meant — a stock "as at" that date, or the flow for the year ending on it —
  // cannot be told from the string alone, so this is reported as its own
  // relation for the caller to weigh rather than silently resolved either way.
  const aInstant = a.start === a.end;
  const bInstant = b.start === b.end;
  if (aInstant !== bInstant) {
    const instant = aInstant ? a : b;
    const span = aInstant ? b : a;
    if (instant.start === span.end) return "BOUNDARY";
  }
  const aContainsB = a.start <= b.start && a.end >= b.end;
  if (aContainsB) return "A_CONTAINS_B";
  const bContainsA = b.start <= a.start && b.end >= a.end;
  if (bContainsA) return "B_CONTAINS_A";
  if (a.end < b.start || b.end < a.start) return "DISJOINT";
  return "OVERLAP";
}

/** Fraction of the year a period covers, used by the numeric ratio diagnostic. */
export function periodMonths(p: Period): number {
  const [ys, ms] = p.start.split("-").map(Number);
  const [ye, me] = p.end.split("-").map(Number);
  return (ye * 12 + me) - (ys * 12 + ms) + 1;
}

/** Compact label for UI and explanations. */
export function periodLabel(p: Period | null): string {
  if (!p) return "unscoped";
  return `${p.raw} [${p.start} → ${p.end}]`;
}
