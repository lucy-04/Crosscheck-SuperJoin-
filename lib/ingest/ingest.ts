/**
 * Ingest orchestration: PDF in, grounded facts out.
 *
 * Stages 1-5 wired together. Deliberately NOT included: canonicalisation and
 * reconciliation. Those run over the whole corpus rather than one document, and
 * separating them is what makes incremental ingest work — adding a seventh PDF
 * re-runs reasoning only for the blocks that document actually touches, instead
 * of rebuilding the knowledge layer.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import type { ScopedClaim } from "@/lib/types";
import { normalizeNumber } from "@/lib/normalize/units";
import { groundClaim } from "@/lib/extract/ground";
import { extractUnits, type ExtractOptions } from "@/lib/extract/extract";
import { parsePdf } from "./parse";
import { segmentDocument } from "./segment";
import {
  findDocumentBySourcePath,
  deleteDocument,
  insertDocument,
  insertFact,
  insertPages,
  insertQuarantine,
  insertUnits,
  updateDocument,
} from "@/lib/db/repo";
import { newId } from "@/lib/db/client";

export interface IngestStats {
  pages: number;
  pagesWithText: number;
  units: number;
  unitsSkipped: number;
  unitsExtracted: number;
  extractionErrors: number;
  claims: number;
  facts: number;
  /** Identical re-extractions of one printed value, stored once. */
  duplicates: number;
  quarantined: number;
  quarantineByReason: Record<string, number>;
  cacheHits: number;
  cacheMisses: number;
  seconds: number;
}

export interface IngestOptions extends ExtractOptions {
  /** Re-ingest even if this path was ingested before. */
  force?: boolean;
  onStage?: (stage: string, detail?: string) => void;
}

/**
 * Filings rarely set a PDF title, so fall back to the filename. Better a
 * readable "Delhivery Annual Report Fy24" than a null the model cannot use for
 * context — the document title is part of what tells it who a fact is about.
 *
 * Exported because the title is embedded in the extraction prompt and therefore
 * in the cache key. Anything that reconstructs a cache key MUST call this rather
 * than reimplement it: a near-identical second copy silently misses every entry.
 */
export function titleFromFilename(filename: string): string {
  return path
    .basename(filename, path.extname(filename))
    .replace(/^\d+[-_]/, "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

export async function ingestPdf(
  sourcePath: string,
  opts: IngestOptions = {},
): Promise<{ documentId: string; stats: IngestStats }> {
  const started = Date.now();
  const stage = opts.onStage ?? (() => {});

  const existing = findDocumentBySourcePath(sourcePath);
  if (existing && !opts.force) {
    throw new Error(
      `Already ingested as ${existing.id}. Pass force to replace it, or use a different file.`,
    );
  }
  if (existing) deleteDocument(existing.id);

  // ---- Stage 1: parse -----------------------------------------------------
  stage("parse", sourcePath);
  const bytes = new Uint8Array(readFileSync(sourcePath));
  const parsed = await parsePdf(bytes);

  const filename = path.basename(sourcePath);
  const title = parsed.title ?? titleFromFilename(filename);
  const documentId = newId("d");

  insertDocument({
    id: documentId,
    filename,
    title,
    publisher: null,
    sourcePath,
    pageCount: parsed.pageCount,
    publishedAt: parsed.publishedAt,
    status: "parsing",
    stats: {},
  });
  insertPages(documentId, parsed.pages);

  // ---- Stage 2: segment ---------------------------------------------------
  stage("segment");
  const { units, skipped } = segmentDocument(parsed.pages, title);
  const unitIds = insertUnits(documentId, units);
  const unitIdByIndex = new Map(units.map((u, i) => [u, unitIds[i]]));

  updateDocument(documentId, { status: "extracting" });

  // ---- Stage 3: extract ---------------------------------------------------
  stage("extract", `${units.length - skipped} salient units`);
  const { results, stats: cacheStats } = await extractUnits(units, {
    ...opts,
    assertedAsOf: parsed.publishedAt,
  });

  // ---- Stages 4-5: ground and normalise ----------------------------------
  stage("ground");
  const pageTexts = new Map(parsed.pages.map((p) => [p.pageNumber, p.text]));

  let claims = 0;
  let facts = 0;
  let quarantined = 0;
  let duplicates = 0;
  let extractionErrors = 0;
  const quarantineByReason: Record<string, number> = {};

  /**
   * Identical claims already stored for this document.
   *
   * Page-sized units overlap in what they see, and a figure printed once is often
   * returned several times — one page yielded the same tonnage nine times. Stored
   * as nine facts they generate C(9,2) = 36 pairs that all "corroborate" each
   * other, drowning the one real cross-document corroboration in noise.
   *
   * Corroboration means INDEPENDENT assertions. The same value, same scope, same
   * page is one assertion read repeatedly, so it is stored once.
   */
  const seen = new Set<string>();
  const identityOf = (c: ScopedClaim) =>
    [
      c.subject.toLowerCase().trim(),
      c.predicate.toLowerCase().trim(),
      "raw" in c.value ? c.value.raw.trim() : "",
      c.scope.period?.raw ?? "",
      [...c.scope.basis].sort().join(","),
      c.evidence.pageNumber,
    ].join("|");

  for (const result of results) {
    if (!result) continue;
    if (result.error) extractionErrors++;
    const unitId = unitIdByIndex.get(result.unit) ?? null;

    for (const claim of result.claims) {
      claims++;
      const pageText = pageTexts.get(claim.evidence.pageNumber);

      if (!pageText) {
        // The model cited a page that does not exist. Rare, but it happens, and
        // it is exactly the sort of thing that must not pass silently.
        quarantined++;
        quarantineByReason.page_not_found = (quarantineByReason.page_not_found ?? 0) + 1;
        insertQuarantine({
          documentId,
          unitId,
          pageNumber: claim.evidence.pageNumber,
          claim,
          reason: "page_not_found",
          detail: `Cited page ${claim.evidence.pageNumber} is outside this document`,
        });
        continue;
      }

      const grounding = groundClaim(claim, pageText);
      if (grounding.status !== "grounded") {
        quarantined++;
        quarantineByReason[grounding.status] = (quarantineByReason[grounding.status] ?? 0) + 1;
        insertQuarantine({
          documentId,
          unitId,
          pageNumber: claim.evidence.pageNumber,
          claim,
          reason: grounding.status,
          detail: grounding.detail,
        });
        continue;
      }

      const identity = identityOf(claim);
      if (seen.has(identity)) {
        duplicates++;
        continue;
      }
      seen.add(identity);

      const normalized = claim.value.kind === "number" ? normalizeNumber(claim.value) : null;

      insertFact({
        documentId,
        unitId,
        claim: withNormalizedValue(claim),
        evidence: {
          quote: claim.evidence.quote,
          pageNumber: claim.evidence.pageNumber,
          charStart: grounding.charStart,
          charEnd: grounding.charEnd,
        },
        grounding: grounding.status,
        normalizedNumber: normalized?.value ?? null,
        normalizedUnit: normalized?.unit ?? null,
      });
      facts++;
    }
  }

  const pagesWithText = parsed.pages.filter((p) => p.text.trim().length > 50).length;
  const stats: IngestStats = {
    pages: parsed.pageCount,
    pagesWithText,
    units: units.length,
    unitsSkipped: skipped,
    unitsExtracted: results.filter(Boolean).length,
    extractionErrors,
    claims,
    facts,
    duplicates,
    quarantined,
    quarantineByReason,
    cacheHits: cacheStats.hits,
    cacheMisses: cacheStats.misses,
    seconds: Math.round((Date.now() - started) / 100) / 10,
  };

  updateDocument(documentId, { status: "ingested", stats: stats as unknown as Record<string, unknown> });
  stage("done", `${facts} facts, ${quarantined} quarantined`);

  return { documentId, stats };
}

/**
 * Attach the normalised form to text-like values so the registry and comparators
 * do not each have to re-derive it.
 */
function withNormalizedValue(claim: ScopedClaim): ScopedClaim {
  const v = claim.value;
  if (v.kind === "categorical" || v.kind === "entity") {
    return { ...claim, value: { ...v, normalized: v.normalized || v.raw } };
  }
  return claim;
}
