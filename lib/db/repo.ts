/**
 * Repository layer: the only place that maps between database rows and domain
 * objects. Keeping the JSON encoding here means the rest of the system never
 * sees a `_json` suffix, and the open-vocabulary fields stay ergonomic despite
 * living in text columns.
 */

import type {
  DimensionDelta,
  Evidence,
  Fact,
  FactType,
  FactValue,
  GroundingStatus,
  Relation,
  Scope,
  ScopedClaim,
  ValueRelation,
  Verdict,
} from "@/lib/types";
import type { ExtractionUnit } from "@/lib/ingest/segment";
import type { ParsedPage } from "@/lib/ingest/parse";
import { getDb, newId, nowIso } from "./client";

/* ------------------------------------------------------------------ *
 * Documents
 * ------------------------------------------------------------------ */

export interface DocumentRecord {
  id: string;
  filename: string;
  title: string | null;
  publisher: string | null;
  sourcePath: string;
  pageCount: number;
  publishedAt: string | null;
  ingestedAt: string;
  status: string;
  stats: Record<string, unknown>;
}

export function insertDocument(doc: Omit<DocumentRecord, "ingestedAt">): DocumentRecord {
  const db = getDb();
  const record: DocumentRecord = { ...doc, ingestedAt: nowIso() };
  db.prepare(
    `INSERT INTO documents
       (id, filename, title, publisher, source_path, page_count, published_at, ingested_at, status, stats_json)
     VALUES (@id, @filename, @title, @publisher, @sourcePath, @pageCount, @publishedAt, @ingestedAt, @status, @stats)`,
  ).run({ ...record, stats: JSON.stringify(record.stats) });
  return record;
}

export function updateDocument(
  id: string,
  patch: { status?: string; pageCount?: number; stats?: Record<string, unknown>; title?: string | null; publishedAt?: string | null },
): void {
  const db = getDb();
  const sets: string[] = [];
  const params: Record<string, unknown> = { id };
  if (patch.status !== undefined) { sets.push("status = @status"); params.status = patch.status; }
  if (patch.pageCount !== undefined) { sets.push("page_count = @pageCount"); params.pageCount = patch.pageCount; }
  if (patch.title !== undefined) { sets.push("title = @title"); params.title = patch.title; }
  if (patch.publishedAt !== undefined) { sets.push("published_at = @publishedAt"); params.publishedAt = patch.publishedAt; }
  if (patch.stats !== undefined) { sets.push("stats_json = @stats"); params.stats = JSON.stringify(patch.stats); }
  if (!sets.length) return;
  db.prepare(`UPDATE documents SET ${sets.join(", ")} WHERE id = @id`).run(params);
}

interface DocRow {
  id: string; filename: string; title: string | null; publisher: string | null;
  source_path: string; page_count: number; published_at: string | null;
  ingested_at: string; status: string; stats_json: string;
}

const toDoc = (r: DocRow): DocumentRecord => ({
  id: r.id,
  filename: r.filename,
  title: r.title,
  publisher: r.publisher,
  sourcePath: r.source_path,
  pageCount: r.page_count,
  publishedAt: r.published_at,
  ingestedAt: r.ingested_at,
  status: r.status,
  stats: JSON.parse(r.stats_json),
});

export function listDocuments(): DocumentRecord[] {
  return (getDb().prepare("SELECT * FROM documents ORDER BY ingested_at DESC").all() as DocRow[]).map(toDoc);
}

export function getDocument(id: string): DocumentRecord | null {
  const row = getDb().prepare("SELECT * FROM documents WHERE id = ?").get(id) as DocRow | undefined;
  return row ? toDoc(row) : null;
}

export function findDocumentBySourcePath(sourcePath: string): DocumentRecord | null {
  const row = getDb()
    .prepare("SELECT * FROM documents WHERE source_path = ?")
    .get(sourcePath) as DocRow | undefined;
  return row ? toDoc(row) : null;
}

export function deleteDocument(id: string): void {
  // Cascades to pages, units, facts, quarantine and (through facts) relations.
  getDb().prepare("DELETE FROM documents WHERE id = ?").run(id);
}

/* ------------------------------------------------------------------ *
 * Pages and units
 * ------------------------------------------------------------------ */

export function insertPages(documentId: string, pages: ParsedPage[]): void {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO pages (document_id, page_number, text, width, height, spans_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const tx = db.transaction((rows: ParsedPage[]) => {
    for (const p of rows) {
      stmt.run(documentId, p.pageNumber, p.text, p.width, p.height, JSON.stringify(p.spans));
    }
  });
  tx(pages);
}

export interface PageRecord {
  pageNumber: number;
  text: string;
  width: number;
  height: number;
  spansJson: string;
}

export function getPage(documentId: string, pageNumber: number): PageRecord | null {
  const row = getDb()
    .prepare("SELECT page_number, text, width, height, spans_json FROM pages WHERE document_id = ? AND page_number = ?")
    .get(documentId, pageNumber) as
    | { page_number: number; text: string; width: number; height: number; spans_json: string }
    | undefined;
  if (!row) return null;
  return {
    pageNumber: row.page_number,
    text: row.text,
    width: row.width,
    height: row.height,
    spansJson: row.spans_json,
  };
}

/** All page texts for a document, keyed by page number — used during grounding. */
export function getPageTexts(documentId: string): Map<number, string> {
  const rows = getDb()
    .prepare("SELECT page_number, text FROM pages WHERE document_id = ?")
    .all(documentId) as { page_number: number; text: string }[];
  return new Map(rows.map((r) => [r.page_number, r.text]));
}

export function insertUnits(documentId: string, units: ExtractionUnit[]): string[] {
  const db = getDb();
  const ids: string[] = [];
  const stmt = db.prepare(
    `INSERT INTO units (id, document_id, page_number, char_start, char_end, text, context_json, salient, extracted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  );
  const tx = db.transaction((rows: ExtractionUnit[]) => {
    for (const u of rows) {
      const id = newId("u");
      ids.push(id);
      stmt.run(id, documentId, u.pageNumber, u.charStart, u.charEnd, u.text, JSON.stringify(u.context), u.salient ? 1 : 0);
    }
  });
  tx(units);
  return ids;
}

/* ------------------------------------------------------------------ *
 * Facts
 * ------------------------------------------------------------------ */

export interface FactInsert {
  documentId: string;
  unitId: string | null;
  claim: ScopedClaim;
  evidence: Evidence;
  grounding: GroundingStatus;
  normalizedNumber: number | null;
  normalizedUnit: string | null;
}

export function insertFact(input: FactInsert): string {
  const db = getDb();
  const id = newId("f");
  db.prepare(
    `INSERT INTO facts
       (id, document_id, unit_id, claim, subject, predicate, fact_type, value_json, scope_json,
        qualifiers_json, evidence_json, grounding, canonical_subject_id, canonical_predicate_id,
        normalized_number, normalized_unit, confidence, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)`,
  ).run(
    id,
    input.documentId,
    input.unitId,
    input.claim.claim,
    input.claim.subject,
    input.claim.predicate,
    input.claim.factType,
    JSON.stringify(input.claim.value),
    JSON.stringify(input.claim.scope),
    JSON.stringify(input.claim.qualifiers),
    JSON.stringify(input.evidence),
    input.grounding,
    input.normalizedNumber,
    input.normalizedUnit,
    input.claim.extractionConfidence,
    nowIso(),
  );
  return id;
}

interface FactRow {
  id: string; document_id: string; unit_id: string | null; claim: string; subject: string;
  predicate: string; fact_type: string; value_json: string; scope_json: string;
  qualifiers_json: string; evidence_json: string; grounding: string;
  canonical_subject_id: string | null; canonical_predicate_id: string | null;
  normalized_number: number | null; normalized_unit: string | null; confidence: number;
  created_at: string;
}

export const toFact = (r: FactRow): Fact => ({
  id: r.id,
  documentId: r.document_id,
  claim: r.claim,
  subject: r.subject,
  predicate: r.predicate,
  factType: r.fact_type as FactType,
  value: JSON.parse(r.value_json) as FactValue,
  scope: JSON.parse(r.scope_json) as Scope,
  qualifiers: JSON.parse(r.qualifiers_json),
  evidence: JSON.parse(r.evidence_json) as Evidence,
  grounding: r.grounding as GroundingStatus,
  canonicalSubjectId: r.canonical_subject_id,
  canonicalPredicateId: r.canonical_predicate_id,
  normalizedNumber: r.normalized_number,
  normalizedUnit: r.normalized_unit,
  extractionConfidence: r.confidence,
});

export function setFactCanonical(
  id: string,
  subjectId: string | null,
  predicateId: string | null,
): void {
  getDb()
    .prepare("UPDATE facts SET canonical_subject_id = ?, canonical_predicate_id = ? WHERE id = ?")
    .run(subjectId, predicateId, id);
}

export function getFact(id: string): Fact | null {
  const row = getDb().prepare("SELECT * FROM facts WHERE id = ?").get(id) as FactRow | undefined;
  return row ? toFact(row) : null;
}

export interface FactFilter {
  documentId?: string;
  factType?: string;
  predicateId?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export function listFacts(filter: FactFilter = {}): Fact[] {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (filter.documentId) { where.push("document_id = @documentId"); params.documentId = filter.documentId; }
  if (filter.factType) { where.push("fact_type = @factType"); params.factType = filter.factType; }
  if (filter.predicateId) { where.push("canonical_predicate_id = @predicateId"); params.predicateId = filter.predicateId; }
  if (filter.search) {
    where.push("(claim LIKE @search OR subject LIKE @search OR predicate LIKE @search)");
    params.search = `%${filter.search}%`;
  }
  const sql = `SELECT * FROM facts ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
               ORDER BY created_at LIMIT @limit OFFSET @offset`;
  params.limit = filter.limit ?? 200;
  params.offset = filter.offset ?? 0;
  return (getDb().prepare(sql).all(params) as FactRow[]).map(toFact);
}

export function countFacts(documentId?: string): number {
  const row = documentId
    ? getDb().prepare("SELECT COUNT(*) n FROM facts WHERE document_id = ?").get(documentId)
    : getDb().prepare("SELECT COUNT(*) n FROM facts").get();
  return (row as { n: number }).n;
}

/** Facts still needing canonicalisation — the incremental ingest entry point. */
export function listUncanonicalisedFacts(limit = 5000): Fact[] {
  return (
    getDb()
      .prepare("SELECT * FROM facts WHERE canonical_predicate_id IS NULL LIMIT ?")
      .all(limit) as FactRow[]
  ).map(toFact);
}

/**
 * Every other fact in the same block: same canonical predicate and subject.
 * This single query is what keeps reconciliation linear rather than quadratic —
 * a new document is compared only against the blocks it actually touches.
 */
export function listBlockMembers(predicateId: string, subjectId: string | null): Fact[] {
  const sql = subjectId
    ? "SELECT * FROM facts WHERE canonical_predicate_id = ? AND canonical_subject_id = ?"
    : "SELECT * FROM facts WHERE canonical_predicate_id = ? AND canonical_subject_id IS NULL";
  const rows = subjectId
    ? (getDb().prepare(sql).all(predicateId, subjectId) as FactRow[])
    : (getDb().prepare(sql).all(predicateId) as FactRow[]);
  return rows.map(toFact);
}

/** Distinct (predicate, subject) pairs that contain more than one fact. */
export function listBlocks(): { predicateId: string; subjectId: string | null; n: number }[] {
  return getDb()
    .prepare(
      `SELECT canonical_predicate_id AS predicateId, canonical_subject_id AS subjectId, COUNT(*) AS n
       FROM facts
       WHERE canonical_predicate_id IS NOT NULL AND grounding = 'grounded'
       GROUP BY canonical_predicate_id, canonical_subject_id
       HAVING n > 1
       ORDER BY n DESC`,
    )
    .all() as { predicateId: string; subjectId: string | null; n: number }[];
}

/* ------------------------------------------------------------------ *
 * Quarantine
 * ------------------------------------------------------------------ */

export function insertQuarantine(input: {
  documentId: string;
  unitId: string | null;
  pageNumber: number | null;
  claim: ScopedClaim;
  reason: string;
  detail: string | null;
}): void {
  getDb()
    .prepare(
      `INSERT INTO quarantine (id, document_id, unit_id, page_number, claim_json, reason, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      newId("q"),
      input.documentId,
      input.unitId,
      input.pageNumber,
      JSON.stringify(input.claim),
      input.reason,
      input.detail,
      nowIso(),
    );
}

export interface QuarantineRecord {
  id: string;
  documentId: string;
  pageNumber: number | null;
  claim: ScopedClaim;
  reason: string;
  detail: string | null;
}

export function listQuarantine(documentId?: string, limit = 200): QuarantineRecord[] {
  const rows = documentId
    ? (getDb().prepare("SELECT * FROM quarantine WHERE document_id = ? LIMIT ?").all(documentId, limit) as Record<string, string>[])
    : (getDb().prepare("SELECT * FROM quarantine LIMIT ?").all(limit) as Record<string, string>[]);
  return rows.map((r) => ({
    id: r.id,
    documentId: r.document_id,
    pageNumber: r.page_number === null ? null : Number(r.page_number),
    claim: JSON.parse(r.claim_json) as ScopedClaim,
    reason: r.reason,
    detail: r.detail,
  }));
}

export function quarantineCounts(documentId?: string): Record<string, number> {
  const rows = documentId
    ? (getDb().prepare("SELECT reason, COUNT(*) n FROM quarantine WHERE document_id = ? GROUP BY reason").all(documentId) as { reason: string; n: number }[])
    : (getDb().prepare("SELECT reason, COUNT(*) n FROM quarantine GROUP BY reason").all() as { reason: string; n: number }[]);
  return Object.fromEntries(rows.map((r) => [r.reason, r.n]));
}

/* ------------------------------------------------------------------ *
 * Relations
 * ------------------------------------------------------------------ */

export function upsertRelation(rel: Omit<Relation, "id">): string {
  const db = getDb();
  const id = newId("r");
  db.prepare(
    `INSERT INTO relations
       (id, fact_a_id, fact_b_id, verdict, confidence, axis, value_relation, deltas_json,
        explanation, decided_by, rule_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(fact_a_id, fact_b_id) DO UPDATE SET
       verdict = excluded.verdict,
       confidence = excluded.confidence,
       axis = excluded.axis,
       value_relation = excluded.value_relation,
       deltas_json = excluded.deltas_json,
       explanation = excluded.explanation,
       decided_by = excluded.decided_by,
       rule_id = excluded.rule_id`,
  ).run(
    id,
    rel.factAId,
    rel.factBId,
    rel.verdict,
    rel.confidence,
    rel.axis,
    rel.valueRelation,
    JSON.stringify(rel.deltas),
    rel.explanation,
    rel.decidedBy,
    rel.ruleId,
    nowIso(),
  );
  return id;
}

interface RelRow {
  id: string; fact_a_id: string; fact_b_id: string; verdict: string; confidence: number;
  axis: string | null; value_relation: string; deltas_json: string; explanation: string;
  decided_by: string; rule_id: string;
}

const toRelation = (r: RelRow): Relation => ({
  id: r.id,
  factAId: r.fact_a_id,
  factBId: r.fact_b_id,
  verdict: r.verdict as Verdict,
  confidence: r.confidence,
  axis: r.axis as Relation["axis"],
  valueRelation: r.value_relation as ValueRelation,
  deltas: JSON.parse(r.deltas_json) as DimensionDelta[],
  explanation: r.explanation,
  decidedBy: r.decided_by as "rule" | "llm",
  ruleId: r.rule_id,
});

export function listRelations(filter: { verdict?: string; limit?: number } = {}): Relation[] {
  const sql = filter.verdict
    ? "SELECT * FROM relations WHERE verdict = ? ORDER BY confidence DESC LIMIT ?"
    : "SELECT * FROM relations ORDER BY confidence DESC LIMIT ?";
  const rows = filter.verdict
    ? (getDb().prepare(sql).all(filter.verdict, filter.limit ?? 200) as RelRow[])
    : (getDb().prepare(sql).all(filter.limit ?? 200) as RelRow[]);
  return rows.map(toRelation);
}

export function listRelationsForFact(factId: string): Relation[] {
  return (
    getDb()
      .prepare("SELECT * FROM relations WHERE fact_a_id = ? OR fact_b_id = ? ORDER BY confidence DESC")
      .all(factId, factId) as RelRow[]
  ).map(toRelation);
}

export function relationCounts(): Record<string, number> {
  const rows = getDb()
    .prepare("SELECT verdict, COUNT(*) n FROM relations GROUP BY verdict")
    .all() as { verdict: string; n: number }[];
  return Object.fromEntries(rows.map((r) => [r.verdict, r.n]));
}

export function clearRelations(): void {
  getDb().prepare("DELETE FROM relations").run();
}
