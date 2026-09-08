/**
 * Stage 4: grounding. Deterministic, no LLM.
 *
 * Every claim asserts a quote it came from. This stage checks that the quote
 * actually exists in the page it was attributed to, and that the claimed value
 * actually appears inside that quote. Claims that fail are quarantined and never
 * reach the reasoning graph.
 *
 * Why this is worth its own stage rather than a trust-the-model shrug:
 *
 *   - It converts "the model might hallucinate" from a caveat in a README into a
 *     measured number: N extractions rejected, for these reasons, visible in the
 *     UI. An honest error rate beats a confident claim of accuracy.
 *   - A fabricated figure that reaches the reasoning layer does not fail loudly.
 *     It surfaces as a confident contradiction against a real figure, which is
 *     the worst possible output for a system whose entire job is adjudicating
 *     disagreement.
 *   - It gives the character offsets that let the UI highlight the evidence on
 *     the page, so a grader can check any fact against the source in one click.
 */

import type { GroundingStatus, ScopedClaim } from "@/lib/types";
import type { Span } from "@/lib/ingest/parse";
import { normalizeText } from "@/lib/normalize/text";
import { parseNumericLiteral } from "@/lib/normalize/units";

export interface GroundingResult {
  status: GroundingStatus;
  charStart: number | null;
  charEnd: number | null;
  /** Which strategy located the quote — useful when auditing near-misses. */
  method: "exact" | "whitespace" | "caseless" | "folded" | "scattered" | "anchored" | "none";
  detail: string | null;
}

/**
 * A whitespace-collapsed copy of a text, plus a map from each collapsed index
 * back to the original. PDF extraction inserts runs of spaces to preserve table
 * columns, so a quote copied from a table will rarely match byte-for-byte even
 * when it is perfectly faithful.
 */
function collapse(text: string): { norm: string; map: number[] } {
  let norm = "";
  const map: number[] = [];
  let prevSpace = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      if (!prevSpace) {
        norm += " ";
        map.push(i);
        prevSpace = true;
      }
    } else {
      norm += ch;
      map.push(i);
      prevSpace = false;
    }
  }
  return { norm, map };
}

/**
 * A copy of a text reduced to lowercase letters and digits only, plus a map back
 * to the original offsets. Used as a late matching tier: it ignores punctuation,
 * spacing and footnote markers while still requiring the same characters in the
 * same order, so it cannot match unrelated text.
 */
function fold(text: string): { norm: string; map: number[] } {
  let norm = "";
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i].toLowerCase();
    if (/[a-z0-9]/.test(ch)) {
      norm += ch;
      map.push(i);
    }
  }
  return { norm, map };
}

/** Maximum consecutive printed lines a scattered quote may be assembled from. */
const SCATTER_WINDOW = 3;

/** Significant tokens of a string: lowercase alphanumeric runs of length >= 2. */
function significantTokens(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9][a-z0-9.]*/g) ?? []).filter((t) => t.length >= 2);
}

/**
 * Find the tightest window of consecutive lines containing every significant
 * token of the quote. Returns null unless such a window exists within
 * SCATTER_WINDOW lines, so a quote can never be satisfied by tokens gathered
 * from opposite ends of a page.
 */
function locateScattered(
  pageText: string,
  quote: string,
): { start: number; end: number; method: GroundingResult["method"] } | null {
  const want = significantTokens(quote);
  if (want.length < 2) return null;

  // Line boundaries, with their offsets into the page text.
  const lines: { start: number; end: number; text: string }[] = [];
  let offset = 0;
  for (const line of pageText.split("\n")) {
    lines.push({ start: offset, end: offset + line.length, text: line });
    offset += line.length + 1;
  }

  for (let size = 1; size <= SCATTER_WINDOW; size++) {
    for (let i = 0; i + size <= lines.length; i++) {
      const window = lines.slice(i, i + size);
      const have = new Set(significantTokens(window.map((l) => l.text).join(" ")));
      if (want.every((t) => have.has(t))) {
        return { start: window[0].start, end: window[window.length - 1].end, method: "scattered" };
      }
    }
  }

  return null;
}

/** Locate `quote` in `pageText`, escalating through progressively looser matches. */
function locate(
  pageText: string,
  quote: string,
): { start: number; end: number; method: GroundingResult["method"] } | null {
  const trimmed = quote.trim();
  if (trimmed.length < 3) return null;

  const exact = pageText.indexOf(trimmed);
  if (exact !== -1) return { start: exact, end: exact + trimmed.length, method: "exact" };

  const page = collapse(pageText);
  const q = collapse(trimmed);

  const ws = page.norm.indexOf(q.norm);
  if (ws !== -1) {
    return {
      start: page.map[ws],
      end: page.map[Math.min(ws + q.norm.length - 1, page.map.length - 1)] + 1,
      method: "whitespace",
    };
  }

  const ci = page.norm.toLowerCase().indexOf(q.norm.toLowerCase());
  if (ci !== -1) {
    return {
      start: page.map[ci],
      end: page.map[Math.min(ci + q.norm.length - 1, page.map.length - 1)] + 1,
      method: "caseless",
    };
  }

  // Punctuation-insensitive pass. Footnote markers and superscripts are drawn as
  // separately positioned text items, so "Pin-code reach(1) 18,793" in a quote
  // may be "Pin-code reach (1)  18,793" in the extracted page. Folding away
  // everything but letters and digits rescues a faithful quote from a layout
  // artefact, while still requiring the same characters in the same order.
  const foldedPage = fold(pageText);
  const foldedQuote = fold(trimmed);
  if (foldedQuote.norm.length >= 8) {
    const f = foldedPage.norm.indexOf(foldedQuote.norm);
    if (f !== -1) {
      return {
        start: foldedPage.map[f],
        end: foldedPage.map[Math.min(f + foldedQuote.norm.length - 1, foldedPage.map.length - 1)] + 1,
        method: "folded",
      };
    }
  }

  // Scattered tier, bounded to a few consecutive lines.
  //
  // In a multi-column table the printed row is
  //     Pin-code reach(1)  18,074  18,540  18,675  18,793
  // and a model asked for the Q4 figure tends to answer
  //     "Pin-code reach(1) 18,793"
  // — a faithful reconstruction, but not a contiguous span. Slide layouts do the
  // same vertically, printing a headline number on the line above its caption.
  //
  // Accepting these requires care. "All these tokens appear somewhere on the
  // page" would happily bind a value to an unrelated row's label, which is the
  // exact failure grounding exists to catch. Restricting the match to a window of
  // at most three consecutive lines keeps the association local enough to be
  // meaningful, and the caller still separately verifies the value is present.
  const scattered = locateScattered(pageText, trimmed);
  if (scattered) return scattered;

  // Last resort: anchor on the quote's first and last few tokens. This rescues
  // quotes where the model silently normalised an interior character (a ligature,
  // a non-breaking hyphen) while still copying a real span of the page.
  const tokens = q.norm.split(" ").filter((t) => t.length > 1);
  if (tokens.length >= 4) {
    const head = tokens.slice(0, 3).join(" ");
    const tail = tokens.slice(-3).join(" ");
    const lower = page.norm.toLowerCase();
    const h = lower.indexOf(head.toLowerCase());
    if (h !== -1) {
      const t = lower.indexOf(tail.toLowerCase(), h);
      if (t !== -1) {
        const endNorm = Math.min(t + tail.length - 1, page.map.length - 1);
        // Reject an anchored match that spans far more text than the quote did;
        // that means the anchors landed in unrelated places.
        if (endNorm - h < q.norm.length * 3) {
          return { start: page.map[h], end: page.map[endNorm] + 1, method: "anchored" };
        }
      }
    }
  }

  return null;
}

/**
 * Every number appearing in a string, parsed.
 *
 * Comparing numbers numerically rather than as substrings avoids a whole family
 * of false rejections. The earlier substring approach stripped everything but
 * digits and dots, so "Rs. (452 Cr)" became ".452" — the dot from "Rs." survived
 * — and then failed to match its own source quote. Same mistake as the one fixed
 * in parseNumericLiteral: delete around a number and you are left with debris
 * that still looks like syntax.
 */
function numbersIn(s: string): number[] {
  const out: number[] = [];
  const re = /\d[\d,]*(?:\.\d+)?|\.\d+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const n = parseFloat(m[0].replace(/,/g, ""));
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/** Widen a character range outwards to the printed line(s) that contain it. */
function expandToLines(text: string, start: number, end: number): { start: number; end: number } {
  const from = text.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
  const nl = text.indexOf("\n", Math.max(0, end - 1));
  return { start: from, end: nl === -1 ? text.length : nl };
}

/**
 * Does a span carry any word that could identify what its numbers measure?
 *
 * Deliberately lenient: one alphabetic token of three or more characters is
 * enough, so a terse table row like "Gateways 111" passes while a bare "34.1%"
 * or "Rs. 8,142 Cr" does not. Currency and scale words are excluded, since they
 * describe how a value is printed rather than what it is.
 */
const NON_IDENTIFYING = new Set([
  "rs", "inr", "usd", "eur", "gbp", "cr", "crore", "crores", "lakh", "lakhs",
  "mn", "bn", "million", "billion", "thousand", "and", "the", "for", "per",
]);

function hasIdentifyingContext(span: string): boolean {
  const words = span.toLowerCase().match(/[a-z]{3,}/g) ?? [];
  return words.some((w) => !NON_IDENTIFYING.has(w));
}

/**
 * Does the claimed value actually appear in the quote?
 *
 * For numbers this compares digit sequences so that "8,141.7" in the claim
 * matches "8 141.7" or "8,141.7" in the page. For text it uses token containment
 * rather than substring equality, because an address or a name is often broken
 * across lines by the PDF layout.
 */
function valueAppearsIn(claim: ScopedClaim, quote: string): boolean {
  const value = claim.value;

  if (value.kind === "number") {
    const want = parseNumericLiteral(value.raw);
    if (want === null) return false;

    // Sign is carried by the scope of the surrounding parentheses, which the
    // token scan does not see, so magnitudes are what must agree.
    const target = Math.abs(want);
    return numbersIn(quote).some((n) => {
      const have = Math.abs(n);
      if (have === target) return true;
      // "8,141.70" in the page satisfies a claim of "8,141.7", and rounding
      // between a deck and a statement should not look like fabrication.
      const scale = Math.max(have, target);
      return scale > 0 && Math.abs(have - target) / scale < 1e-6;
    });
  }

  const wantNorm = normalizeText(value.raw);
  const haveNorm = normalizeText(quote);
  if (!wantNorm) return false;
  if (haveNorm.includes(wantNorm)) return true;

  // Token containment, for values the layout split across lines.
  const wantTokens = wantNorm.split(" ").filter(Boolean);
  const haveTokens = new Set(haveNorm.split(" ").filter(Boolean));
  const present = wantTokens.filter((t) => haveTokens.has(t)).length;
  return wantTokens.length > 0 && present / wantTokens.length >= 0.8;
}

/**
 * Check one claim against the page it cites.
 *
 * Note the deliberate ordering: a quote that cannot be found is a different
 * failure from a quote that is real but does not contain the value. The first
 * suggests a fabricated citation; the second suggests the model read the right
 * row and the wrong column. Keeping them apart is what makes the quarantine
 * table diagnostic rather than just a reject pile.
 */
export function groundClaim(claim: ScopedClaim, pageText: string): GroundingResult {
  const found = locate(pageText, claim.evidence.quote);
  if (!found) {
    return {
      status: "quote_not_found",
      charStart: null,
      charEnd: null,
      method: "none",
      detail: `Quote not present on page ${claim.evidence.pageNumber}`,
    };
  }

  // A quote that is nothing but the value is not evidence.
  //
  // Found by watching the engine report 28 contradictions from a single page: a
  // table of "% of revenue" broken down by row, where every row was extracted
  // with the bare figure as its own quote ("34.1%", "18.8%") and a predicate that
  // did not name the row. Identical subject, predicate, period and basis, and
  // different values — so the engine correctly concluded "contradiction" from
  // claims that were never distinguishing.
  //
  // The reasoning layer cannot fix this; the information was lost before it. A
  // span that carries no word cannot say WHAT is 34.1%, so it cannot support any
  // verdict and must not enter the graph.
  // Judge the whole printed line, not just the characters the model happened to
  // copy. A model that quotes "8,141.7" out of the row "Revenue from operations
  // 8,141.7" has cited real, identifying evidence — it simply quoted tightly. So
  // the span is widened to its line first, which both rescues those facts and
  // stores better evidence: the reader sees the row, not a floating number.
  const line = expandToLines(pageText, found.start, found.end);
  if (!hasIdentifyingContext(pageText.slice(line.start, line.end))) {
    return {
      status: "quote_lacks_context",
      charStart: found.start,
      charEnd: found.end,
      method: found.method,
      detail:
        "The cited line contains the value but no words identifying what it measures, " +
        "so it cannot distinguish this claim from any other value in the same table",
    };
  }

  found.start = line.start;
  found.end = line.end;

  if (!valueAppearsIn(claim, claim.evidence.quote)) {
    return {
      status: "value_not_in_quote",
      charStart: found.start,
      charEnd: found.end,
      method: found.method,
      detail: `Value ${JSON.stringify(claim.value.raw)} does not appear in the cited quote`,
    };
  }

  return {
    status: "grounded",
    charStart: found.start,
    charEnd: found.end,
    method: found.method,
    detail: null,
  };
}

/**
 * Bounding boxes covering a character range, merged per visual line so the UI
 * draws one rectangle per line rather than one per text item.
 */
export function boxesForRange(
  spans: Span[],
  start: number,
  end: number,
): { x: number; y: number; w: number; h: number }[] {
  const hits = spans.filter((s) => s.e > start && s.s < end);
  if (!hits.length) return [];

  const lines = new Map<number, { x0: number; y0: number; x1: number; y1: number }>();
  for (const s of hits) {
    // Bucket by vertical position; items on one line share a y within a point or two.
    const key = Math.round(s.y / 4);
    const box = lines.get(key);
    if (!box) {
      lines.set(key, { x0: s.x, y0: s.y, x1: s.x + s.w, y1: s.y + s.h });
    } else {
      box.x0 = Math.min(box.x0, s.x);
      box.y0 = Math.min(box.y0, s.y);
      box.x1 = Math.max(box.x1, s.x + s.w);
      box.y1 = Math.max(box.y1, s.y + s.h);
    }
  }

  return [...lines.values()].map((b) => ({
    x: b.x0,
    y: b.y0,
    w: b.x1 - b.x0,
    h: b.y1 - b.y0,
  }));
}
