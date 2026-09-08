/**
 * Storage schema.
 *
 * A note on a question this design invites: does a relational schema contradict
 * the brief's "no hard-coded schemas"? No — the brief forbids a hard-coded FACT
 * schema (a system that knows in advance it extracts revenue, PAT and headcount)
 * while explicitly leaving storage to us. What is fixed below is only the
 * envelope every claim shares: subject, predicate, value, scope, evidence. The
 * contents are open — `predicate` is free text, `value_json` is a tagged union,
 * `basis` and `qualifiers_json` are open vocabularies. A document about monetary
 * policy and one about parcel logistics produce the same row shape, and a new
 * kind of fact never requires a migration.
 *
 * SQLite specifically, because reconciliation is dominated by BLOCKING lookups —
 * "every fact sharing this canonical predicate and subject" — run once per fact
 * on every ingest. That is an indexed join, and it is the operation the whole
 * incremental story rests on. Swapping to Postgres is one file (client.ts).
 */

export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Source documents. published_at drives vintage ordering: when two documents
-- disagree, which one is the later word on the subject?
CREATE TABLE IF NOT EXISTS documents (
  id            TEXT PRIMARY KEY,
  filename      TEXT NOT NULL,
  title         TEXT,
  publisher     TEXT,
  source_path   TEXT NOT NULL,
  page_count    INTEGER NOT NULL DEFAULT 0,
  published_at  TEXT,
  ingested_at   TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  stats_json    TEXT NOT NULL DEFAULT '{}'
);

-- Extracted page text plus the character-to-bounding-box map that lets the UI
-- draw a highlight over the exact words a fact came from.
CREATE TABLE IF NOT EXISTS pages (
  document_id   TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page_number   INTEGER NOT NULL,
  text          TEXT NOT NULL,
  width         REAL NOT NULL DEFAULT 0,
  height        REAL NOT NULL DEFAULT 0,
  spans_json    TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (document_id, page_number)
);

-- The chunks actually sent for extraction, with the heading context that carries
-- the scope qualifiers ("Consolidated", "Rs. in crore") sitting above a table.
CREATE TABLE IF NOT EXISTS units (
  id            TEXT PRIMARY KEY,
  document_id   TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page_number   INTEGER NOT NULL,
  char_start    INTEGER NOT NULL,
  char_end      INTEGER NOT NULL,
  text          TEXT NOT NULL,
  context_json  TEXT NOT NULL DEFAULT '{}',
  salient       INTEGER NOT NULL DEFAULT 1,
  extracted     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_units_doc ON units(document_id);

-- Facts that passed the grounding check. Everything open-ended lives in a JSON
-- column, queryable via SQLite's JSON1 functions.
CREATE TABLE IF NOT EXISTS facts (
  id                     TEXT PRIMARY KEY,
  document_id            TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  unit_id                TEXT,
  claim                  TEXT NOT NULL,
  subject                TEXT NOT NULL,
  predicate              TEXT NOT NULL,
  fact_type              TEXT NOT NULL,
  value_json             TEXT NOT NULL,
  scope_json             TEXT NOT NULL,
  qualifiers_json        TEXT NOT NULL DEFAULT '{}',
  evidence_json          TEXT NOT NULL,
  grounding              TEXT NOT NULL,
  canonical_subject_id   TEXT,
  canonical_predicate_id TEXT,
  normalized_number      REAL,
  normalized_unit        TEXT,
  confidence             REAL NOT NULL DEFAULT 0,
  created_at             TEXT NOT NULL
);
-- The blocking index. Every reconciliation pass is driven by this lookup, which
-- is what keeps comparison linear in corpus size instead of quadratic.
CREATE INDEX IF NOT EXISTS idx_facts_block
  ON facts(canonical_predicate_id, canonical_subject_id);
CREATE INDEX IF NOT EXISTS idx_facts_doc ON facts(document_id);

-- Extractions rejected by the grounding check. Kept, not deleted: they are the
-- system's own error log, and the honest answer to "what does not work yet".
CREATE TABLE IF NOT EXISTS quarantine (
  id            TEXT PRIMARY KEY,
  document_id   TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  unit_id       TEXT,
  page_number   INTEGER,
  claim_json    TEXT NOT NULL,
  reason        TEXT NOT NULL,
  detail        TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_quarantine_doc ON quarantine(document_id);

-- The vocabulary that grows as documents arrive: one table, three namespaces
-- ('subject', 'predicate', 'value'). This IS the evolving schema — new kinds of
-- fact mint new canonical entries here rather than new columns anywhere.
CREATE TABLE IF NOT EXISTS registry_entries (
  id             TEXT PRIMARY KEY,
  namespace      TEXT NOT NULL,
  canonical      TEXT NOT NULL,
  normalized     TEXT NOT NULL,
  aliases_json   TEXT NOT NULL DEFAULT '[]',
  embedding      BLOB,
  occurrences    INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_registry_ns ON registry_entries(namespace, normalized);

-- Learned relations between registry entries. Two do real work downstream:
-- predicate 'subsumes' ("revenue from operations" is part of "total income")
-- makes a value gap reconcilable; value 'exclusive' ("resigned" vs "in office")
-- is what lets the engine judge non-numeric facts at all.
CREATE TABLE IF NOT EXISTS registry_relations (
  id         TEXT PRIMARY KEY,
  namespace  TEXT NOT NULL,
  a_id       TEXT NOT NULL REFERENCES registry_entries(id) ON DELETE CASCADE,
  b_id       TEXT NOT NULL REFERENCES registry_entries(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  source     TEXT NOT NULL DEFAULT 'llm',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_regrel_a ON registry_relations(a_id);
CREATE INDEX IF NOT EXISTS idx_regrel_b ON registry_relations(b_id);

-- The output of the reconciliation engine. deltas_json holds the per-axis
-- comparison, so every verdict can show its own reasoning rather than asserting.
CREATE TABLE IF NOT EXISTS relations (
  id             TEXT PRIMARY KEY,
  fact_a_id      TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
  fact_b_id      TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
  verdict        TEXT NOT NULL,
  confidence     REAL NOT NULL DEFAULT 0,
  axis           TEXT,
  value_relation TEXT NOT NULL,
  deltas_json    TEXT NOT NULL DEFAULT '[]',
  explanation    TEXT NOT NULL,
  decided_by     TEXT NOT NULL,
  rule_id        TEXT NOT NULL,
  created_at     TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_relations_pair ON relations(fact_a_id, fact_b_id);
CREATE INDEX IF NOT EXISTS idx_relations_verdict ON relations(verdict);
CREATE INDEX IF NOT EXISTS idx_relations_a ON relations(fact_a_id);
CREATE INDEX IF NOT EXISTS idx_relations_b ON relations(fact_b_id);
`;
