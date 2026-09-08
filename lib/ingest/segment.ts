/**
 * Segmentation: turning page text into the chunks that get extracted.
 *
 * This stage decides what the extractor is allowed to see, and it is where the
 * project's central claim either works or quietly fails. The reason is that
 * scope qualifiers do not sit next to their numbers:
 *
 *     Consolidated Statement of Profit and Loss          <- entity scope
 *     for the year ended March 31, 2024                  <- period
 *     (Rs. in crore)                                     <- unit and scale
 *     ...
 *     Revenue from operations              8,141.7       <- the only line a naive
 *                                                           chunker would send
 *
 * Send that last line alone and the model must invent a scope or omit one. Either
 * way every downstream comparison is poisoned. So each unit carries the headings
 * and unit captions standing above it, and units never cross a page boundary —
 * evidence must resolve to exactly one page to be highlightable.
 */

import type { ParsedPage } from "./parse";

export interface UnitContext {
  documentTitle: string | null;
  pageNumber: number;
  /** Nearest preceding headings, outermost first. */
  headings: string[];
  /** Unit/scale and basis captions in force over this unit, e.g. "(Rs. in crore)". */
  captions: string[];
}

export interface ExtractionUnit {
  pageNumber: number;
  charStart: number;
  charEnd: number;
  text: string;
  context: UnitContext;
  /** False when the unit is prose with nothing extractable; skipped, not deleted. */
  salient: boolean;
}

/**
 * Unit sizing.
 *
 * A PAGE is the default extraction unit, not a fixed-size chunk. That is a
 * deliberate reversal of the obvious approach, and the reason is worth stating
 * because it was measured rather than assumed.
 *
 * Small chunks optimise for CONTEXT limits. Context was never the binding
 * constraint here — a page of these filings is about 7,000 characters, which any
 * current model swallows whole. The binding constraint is REQUEST COUNT: the
 * rate limit on the model endpoint. At ~1,600-character units the six starter
 * PDFs need roughly 3,250 calls; at page granularity they need about 510.
 *
 * It is also the better unit on the merits. A financial table stays physically
 * attached to the caption and headings that scope it, rather than depending on
 * heuristics to copy that context onto a fragment. And the page boundary was
 * already mandatory, since evidence must resolve to one page to be highlightable.
 *
 * Block mode is retained for pages too large to send whole.
 */
const PAGE_SOFT_LIMIT = 9000;
const PAGE_HARD_LIMIT = 14000;

/** Target and hard cap when a page must be split into blocks. */
const TARGET_CHARS = 4000;
const MAX_CHARS = 6000;

/**
 * Captions that declare the unit and scale a table's numbers are printed in.
 * Matched anywhere on a line, because "(Rs. in crore)" appears inline as often as
 * it appears as a heading. The match is kept tight — no trailing wildcard — since
 * a caption is a label, not the rest of the row.
 */
const SCALE_CAPTION =
  /(?:₹|rs\.?|inr|usd|us\$|\$|€|£)\s*(?:in\s+)?(?:crores?|lakhs?|lacs?|millions?|billions?|thousands?|mn|bn|cr)\b|\b(?:amounts?|figures|values)\s+(?:are\s+)?in\s+[a-z₹$.\s]{0,24}(?:crores?|lakhs?|millions?|billions?|thousands?)\b/i;

/**
 * Qualifiers that change what a number MEANS rather than how it is printed.
 * Only read from short, heading-shaped lines: the word "consolidated" inside a
 * paragraph of narrative is prose, not a scope declaration, and treating it as
 * one would stamp a false basis onto every fact on the page.
 */
const BASIS_CAPTION =
  /\b(consolidated|standalone|unconsolidated|combined|restated|pro\s*forma|seasonally\s+adjusted|annualised|annualized|provisional|revised|projected|estimated)\b/i;

/** Longest line still plausibly a heading rather than a sentence. */
const CAPTION_LINE_MAX = 100;

/**
 * Signals that a chunk may contain a fact. Deliberately NOT digits-only: the
 * brief's own examples include a director resigning and an address written two
 * ways, and a numeric filter would silently discard every one of them.
 */
const SEMANTIC_SIGNALS =
  /\b(director|chairman|chairperson|chief|officer|ceo|cfo|managing|secretary|auditor|appoint|resign|retire|ceased|vacat|incorporat|registered\s+office|corporate\s+office|address|situated|premises|promoter|subsidiar|acquir|merger|amalgamat|headquarter|located)\b/i;

const DATE_SIGNAL =
  /\b(?:fy\s*'?\d{2,4}|q[1-4]\s*fy|\d{4}\s*-\s*\d{2,4}|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i;

function isHeading(line: string): boolean {
  const t = line.trim();
  if (!t || t.length > 90) return false;
  if (/[.;]$/.test(t)) return false;
  const words = t.split(/\s+/);
  if (words.length > 12) return false;

  const letters = t.replace(/[^A-Za-z]/g, "");
  if (letters.length < 3) return false;

  // ALL CAPS, or Title Case, or a numbered section heading.
  if (letters === letters.toUpperCase()) return true;
  if (/^\d+(\.\d+)*[.)]?\s+\S/.test(t)) return true;
  const capitalised = words.filter((w) => /^[A-Z]/.test(w)).length;
  return capitalised / words.length >= 0.6;
}

/**
 * Scope captions found on a line, tagged by kind so the two can be retained
 * independently. A page usually declares its scale once and its basis once; both
 * must survive, and neither should be crowded out by the other.
 */
function captionsIn(line: string): { scale: string[]; basis: string[] } {
  const scale: string[] = [];
  const basis: string[] = [];

  const s = line.match(SCALE_CAPTION);
  if (s) scale.push(s[0].trim());

  if (line.length <= CAPTION_LINE_MAX) {
    const b = line.match(BASIS_CAPTION);
    if (b) basis.push(b[0].trim().toLowerCase());
  }

  return { scale, basis };
}

/** Keep the first occurrences of each distinct caption, case-insensitively. */
function firstUnique(values: string[], limit: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const k = v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
    if (out.length >= limit) break;
  }
  return out;
}

function isSalient(text: string): boolean {
  return /\d/.test(text) || SEMANTIC_SIGNALS.test(text) || DATE_SIGNAL.test(text);
}

/**
 * Running headers and footers repeat on every page ("Delhivery Limited | Annual
 * Report 2023-24"). They are pure noise: they cost tokens on every single call
 * and, worse, can be mistaken for a heading that scopes the page's content.
 */
export function detectBoilerplate(pages: ParsedPage[]): Set<string> {
  if (pages.length < 5) return new Set();
  const counts = new Map<string, number>();
  for (const page of pages) {
    const lines = page.text.split("\n").map((l) => l.trim());
    // Only the top and bottom few lines can be running heads.
    const candidates = new Set([...lines.slice(0, 3), ...lines.slice(-3)]);
    for (const line of candidates) {
      if (line.length < 8 || line.length > 120) continue;
      counts.set(line, (counts.get(line) ?? 0) + 1);
    }
  }
  const threshold = Math.max(3, Math.floor(pages.length * 0.5));
  const boiler = new Set<string>();
  for (const [line, n] of counts) if (n >= threshold) boiler.add(line);
  return boiler;
}

/**
 * Split one page into extraction units, each carrying the headings and captions
 * that scope it.
 *
 * In "page" mode (the default) this yields exactly one unit per page unless the
 * page is unusually large. In "block" mode it splits on headings and size, which
 * is what a page over the hard limit falls back to.
 */
export function segmentPage(
  page: ParsedPage,
  documentTitle: string | null,
  boilerplate: Set<string> = new Set(),
  mode: "page" | "block" = "page",
): ExtractionUnit[] {
  const units: ExtractionUnit[] = [];
  const lines = page.text.split("\n");

  // A page small enough to send whole is sent whole; only oversized pages are
  // broken up, and then on heading boundaries so scope context survives.
  if (mode === "page" && page.text.length > PAGE_HARD_LIMIT) {
    return segmentPage(page, documentTitle, boilerplate, "block");
  }
  const pageMode = mode === "page";

  // Headings and captions accumulate as we walk down the page, so a unit inherits
  // whatever was declared above it. Headings keep the LAST few (the innermost
  // section wins), captions keep the FIRST few (a table declares its scale once,
  // at the top, and later lines are data rather than further declarations).
  let headings: string[] = [];
  const scaleCaptions: string[] = [];
  const basisCaptions: string[] = [];

  let buf: string[] = [];
  let bufStart = 0;
  let offset = 0;

  const flush = (endOffset: number) => {
    const text = buf.join("\n").trim();
    if (text.length >= 24) {
      units.push({
        pageNumber: page.pageNumber,
        charStart: bufStart,
        charEnd: endOffset,
        text,
        context: {
          documentTitle,
          pageNumber: page.pageNumber,
          headings: [...headings].slice(-4),
          captions: [...firstUnique(scaleCaptions, 2), ...firstUnique(basisCaptions, 2)],
        },
        salient: isSalient(text),
      });
    }
    buf = [];
  };

  for (const line of lines) {
    const lineStart = offset;
    offset += line.length + 1; // +1 for the newline consumed by split
    const trimmed = line.trim();

    if (!trimmed || boilerplate.has(trimmed)) continue;

    const caps = captionsIn(trimmed);
    scaleCaptions.push(...caps.scale);
    basisCaptions.push(...caps.basis);

    if (isHeading(trimmed)) {
      headings.push(trimmed);
      if (headings.length > 4) headings = headings.slice(-4);

      if (pageMode) {
        // Keep the heading in the text: the model reads it in place, exactly as
        // a person would, instead of relying on it being copied into context.
        if (!buf.length) bufStart = lineStart;
        buf.push(line);
        continue;
      }

      // Block mode: a heading closes the previous unit and opens a new context.
      if (buf.length) flush(lineStart);
      bufStart = lineStart;
      continue;
    }

    if (!buf.length) bufStart = lineStart;
    buf.push(line);

    const size = buf.join("\n").length;
    const limit = pageMode ? PAGE_SOFT_LIMIT : TARGET_CHARS;
    if (size >= limit) flush(offset);
    else if (!pageMode && size >= MAX_CHARS) flush(offset);
  }

  if (buf.length) flush(offset);
  return units;
}

/** Segment a whole document, stripping running headers first. */
export function segmentDocument(
  pages: ParsedPage[],
  documentTitle: string | null,
): { units: ExtractionUnit[]; skipped: number } {
  const boilerplate = detectBoilerplate(pages);
  const units: ExtractionUnit[] = [];
  for (const page of pages) {
    units.push(...segmentPage(page, documentTitle, boilerplate));
  }
  const skipped = units.filter((u) => !u.salient).length;
  return { units, skipped };
}

/**
 * Render a unit for the model: the context first, then the text. The model is
 * told where the context came from so it can attribute a caption's scale to a
 * table without treating the caption itself as a fact.
 */
export function renderUnitForPrompt(unit: ExtractionUnit): string {
  const c = unit.context;
  const parts: string[] = [];
  if (c.documentTitle) parts.push(`DOCUMENT: ${c.documentTitle}`);
  parts.push(`PAGE: ${c.pageNumber}`);
  if (c.headings.length) parts.push(`SECTION CONTEXT: ${c.headings.join(" > ")}`);
  if (c.captions.length) parts.push(`SCOPE CAPTIONS ON THIS PAGE: ${c.captions.join(" | ")}`);
  parts.push("", "PAGE EXCERPT:", unit.text);
  return parts.join("\n");
}
