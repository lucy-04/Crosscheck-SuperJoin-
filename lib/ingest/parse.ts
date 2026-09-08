/**
 * PDF text extraction with position data.
 *
 * Two requirements shape this beyond "get the text out":
 *
 * 1. Every character must keep its coordinates, so a fact's evidence quote can be
 *    highlighted on the rendered page. Evidence a grader cannot see is not
 *    evidence, and "trust me, page 47" is exactly what this project must avoid.
 *
 * 2. Table layout must survive. Financial tables are where the scope qualifiers
 *    live, and a naive extractor that concatenates text items in stream order
 *    turns a five-column table into an unreadable ribbon of digits. Horizontal
 *    gaps are therefore reconstructed as runs of spaces — the same trick
 *    `pdftotext -layout` uses, and LLMs read the result well.
 */

import type { TextItem } from "pdfjs-dist/types/src/display/api";

/** A run of characters in the page text, with its box on the rendered page. */
export interface Span {
  /** Inclusive start offset into the page text. */
  s: number;
  /** Exclusive end offset into the page text. */
  e: number;
  /** Top-left origin, in PDF points at scale 1. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ParsedPage {
  pageNumber: number;
  text: string;
  width: number;
  height: number;
  spans: Span[];
}

export interface ParsedDocument {
  title: string | null;
  publishedAt: string | null;
  pageCount: number;
  pages: ParsedPage[];
}

/** Items whose baselines are within this many points count as one visual line. */
const LINE_TOLERANCE = 3;

/** Cap on reconstructed gap spaces, so a sparse table cannot explode the text. */
const MAX_GAP_SPACES = 12;

let pdfjsPromise: Promise<typeof import("pdfjs-dist/legacy/build/pdf.mjs")> | null = null;

/**
 * pdfjs is loaded lazily and from its legacy build: the modern build assumes
 * browser globals, and a top-level import would drag it into every route that
 * merely touches ingestion types.
 */
async function getPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist/legacy/build/pdf.mjs");
  }
  return pdfjsPromise;
}

function isTextItem(item: unknown): item is TextItem {
  return typeof (item as TextItem)?.str === "string";
}

/**
 * Assemble one page's text items into laid-out lines, recording the character
 * range each item occupies so offsets map back to boxes.
 */
function layoutPage(items: TextItem[], viewportHeight: number): { text: string; spans: Span[] } {
  const visible = items.filter((it) => it.str.length > 0);
  if (!visible.length) return { text: "", spans: [] };

  // PDF y grows upward, so descending y is top-to-bottom reading order.
  const sorted = [...visible].sort((a, b) => {
    const dy = b.transform[5] - a.transform[5];
    if (Math.abs(dy) > LINE_TOLERANCE) return dy;
    return a.transform[4] - b.transform[4];
  });

  const lines: TextItem[][] = [];
  let current: TextItem[] = [];
  let currentY = Number.NaN;

  for (const item of sorted) {
    const y = item.transform[5];
    if (Number.isNaN(currentY) || Math.abs(y - currentY) <= LINE_TOLERANCE) {
      current.push(item);
      currentY = Number.isNaN(currentY) ? y : currentY;
    } else {
      lines.push(current);
      current = [item];
      currentY = y;
    }
  }
  if (current.length) lines.push(current);

  const spans: Span[] = [];
  let text = "";

  for (const line of lines) {
    let prevRight: number | null = null;
    for (const item of line) {
      const x = item.transform[4];
      const height = Math.abs(item.transform[3]) || item.height || 10;
      const width = item.width || 0;

      if (prevRight !== null) {
        const gap = x - prevRight;
        // Approximate character width from this item, then express the gap in
        // characters. This is what preserves column alignment in tables.
        const charWidth = item.str.length ? width / item.str.length : height * 0.5;
        const gapChars = charWidth > 0 ? Math.round(gap / charWidth) : 0;
        if (gapChars >= 1) text += " ".repeat(Math.min(gapChars, MAX_GAP_SPACES));
      }

      const start = text.length;
      text += item.str;
      spans.push({
        s: start,
        e: text.length,
        x,
        // Convert from PDF's bottom-left origin to the top-left origin the UI uses.
        y: viewportHeight - item.transform[5] - height,
        w: width,
        h: height,
      });
      prevRight = x + width;
    }
    text += "\n";
  }

  return { text, spans };
}

/** Pull a usable title and publication date out of PDF metadata, if present. */
function readMeta(info: Record<string, unknown> | undefined): {
  title: string | null;
  publishedAt: string | null;
} {
  const title = typeof info?.Title === "string" && info.Title.trim() ? info.Title.trim() : null;
  // PDF dates look like "D:20240812153000+05'30'".
  const raw = typeof info?.CreationDate === "string" ? info.CreationDate : null;
  let publishedAt: string | null = null;
  if (raw) {
    const m = raw.match(/D:(\d{4})(\d{2})(\d{2})/);
    if (m) publishedAt = `${m[1]}-${m[2]}-${m[3]}`;
  }
  return { title, publishedAt };
}

export interface ParseOptions {
  /** Called after each page so long documents can report progress as they go. */
  onPage?: (page: ParsedPage, total: number) => void;
}

/**
 * Parse a PDF into laid-out page text plus character-to-box spans.
 *
 * Pages are released as soon as they are converted, so peak memory tracks the
 * largest single page rather than the whole document — the reason a 100-page
 * filing costs about the same as a 10-page one here.
 */
export async function parsePdf(data: Uint8Array, opts: ParseOptions = {}): Promise<ParsedDocument> {
  const pdfjs = await getPdfjs();

  const doc = await pdfjs.getDocument({
    data,
    // Node has no DOM; these keep pdfjs from reaching for browser-only features.
    useSystemFonts: false,
    isEvalSupported: false,
    verbosity: 0,
  }).promise;

  const meta = await doc.getMetadata().catch(() => null);
  const { title, publishedAt } = readMeta(meta?.info as Record<string, unknown> | undefined);

  const pages: ParsedPage[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const items = content.items.filter(isTextItem);
    const { text, spans } = layoutPage(items, viewport.height);

    const parsed: ParsedPage = {
      pageNumber: n,
      text,
      width: viewport.width,
      height: viewport.height,
      spans,
    };
    pages.push(parsed);
    opts.onPage?.(parsed, doc.numPages);
    page.cleanup();
  }

  await doc.destroy();

  return { title, publishedAt, pageCount: doc.numPages, pages };
}
