/**
 * Persistence for the vocabulary registry.
 *
 * One table, three namespaces. This table IS the "schema that evolves as new
 * kinds of fact appear": a document introducing a metric nobody has seen mints a
 * row here rather than requiring a column anywhere.
 */

import { decodeEmbedding, encodeEmbedding, getDb, newId, nowIso } from "@/lib/db/client";

export type Namespace = "subject" | "predicate" | "value";

/** Relations the registry can learn between two entries. */
export type RegistryRelationKind =
  | "subsumes" // predicate: a is broader than b ("total income" subsumes "other income")
  | "exclusive" // value: a and b cannot both hold ("resigned" vs "in office")
  | "compatible"; // value: a and b can both hold ("Director" and "Chairman")

export interface RegistryEntry {
  id: string;
  namespace: Namespace;
  canonical: string;
  normalized: string;
  aliases: string[];
  embedding: number[] | null;
  occurrences: number;
}

interface EntryRow {
  id: string;
  namespace: string;
  canonical: string;
  normalized: string;
  aliases_json: string;
  embedding: Buffer | null;
  occurrences: number;
}

const toEntry = (r: EntryRow): RegistryEntry => ({
  id: r.id,
  namespace: r.namespace as Namespace,
  canonical: r.canonical,
  normalized: r.normalized,
  aliases: JSON.parse(r.aliases_json),
  embedding: decodeEmbedding(r.embedding),
  occurrences: r.occurrences,
});

export function listEntries(namespace?: Namespace): RegistryEntry[] {
  const rows = namespace
    ? (getDb().prepare("SELECT * FROM registry_entries WHERE namespace = ? ORDER BY occurrences DESC").all(namespace) as EntryRow[])
    : (getDb().prepare("SELECT * FROM registry_entries ORDER BY namespace, occurrences DESC").all() as EntryRow[]);
  return rows.map(toEntry);
}

export function getEntry(id: string): RegistryEntry | null {
  const row = getDb().prepare("SELECT * FROM registry_entries WHERE id = ?").get(id) as EntryRow | undefined;
  return row ? toEntry(row) : null;
}

/** Exact hit on the normalised form — the free, certain path. */
export function findByNormalized(namespace: Namespace, normalized: string): RegistryEntry | null {
  const row = getDb()
    .prepare("SELECT * FROM registry_entries WHERE namespace = ? AND normalized = ?")
    .get(namespace, normalized) as EntryRow | undefined;
  return row ? toEntry(row) : null;
}

export function createEntry(input: {
  namespace: Namespace;
  canonical: string;
  normalized: string;
  embedding: number[] | null;
}): RegistryEntry {
  const id = newId("reg");
  getDb()
    .prepare(
      `INSERT INTO registry_entries (id, namespace, canonical, normalized, aliases_json, embedding, occurrences, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
    )
    .run(
      id,
      input.namespace,
      input.canonical,
      input.normalized,
      JSON.stringify([input.canonical]),
      input.embedding ? encodeEmbedding(input.embedding) : null,
      nowIso(),
    );
  return {
    id,
    namespace: input.namespace,
    canonical: input.canonical,
    normalized: input.normalized,
    aliases: [input.canonical],
    embedding: input.embedding,
    occurrences: 1,
  };
}

/** Record another surface form for an existing entry and bump its use count. */
export function addAlias(id: string, alias: string): void {
  const db = getDb();
  const row = db.prepare("SELECT aliases_json FROM registry_entries WHERE id = ?").get(id) as
    | { aliases_json: string }
    | undefined;
  if (!row) return;

  const aliases: string[] = JSON.parse(row.aliases_json);
  if (!aliases.some((a) => a.toLowerCase() === alias.toLowerCase())) aliases.push(alias);

  db.prepare("UPDATE registry_entries SET aliases_json = ?, occurrences = occurrences + 1 WHERE id = ?")
    .run(JSON.stringify(aliases), id);
}

export interface RegistryRelation {
  id: string;
  namespace: Namespace;
  aId: string;
  bId: string;
  kind: RegistryRelationKind;
  source: string;
}

export function addRelation(input: {
  namespace: Namespace;
  aId: string;
  bId: string;
  kind: RegistryRelationKind;
  source?: string;
}): void {
  // Relations are symmetric for exclusive/compatible and directed for subsumes;
  // store one row and let readers interpret direction by kind.
  const db = getDb();
  const exists = db
    .prepare("SELECT id FROM registry_relations WHERE a_id = ? AND b_id = ? AND kind = ?")
    .get(input.aId, input.bId, input.kind);
  if (exists) return;

  db.prepare(
    `INSERT INTO registry_relations (id, namespace, a_id, b_id, kind, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(newId("rr"), input.namespace, input.aId, input.bId, input.kind, input.source ?? "llm", nowIso());
}

interface RelRow {
  id: string; namespace: string; a_id: string; b_id: string; kind: string; source: string;
}

export function listRelationsFor(id: string): RegistryRelation[] {
  return (
    getDb()
      .prepare("SELECT * FROM registry_relations WHERE a_id = ? OR b_id = ?")
      .all(id, id) as RelRow[]
  ).map((r) => ({
    id: r.id,
    namespace: r.namespace as Namespace,
    aId: r.a_id,
    bId: r.b_id,
    kind: r.kind as RegistryRelationKind,
    source: r.source,
  }));
}

export function listAllRelations(): RegistryRelation[] {
  return (getDb().prepare("SELECT * FROM registry_relations").all() as RelRow[]).map((r) => ({
    id: r.id,
    namespace: r.namespace as Namespace,
    aId: r.a_id,
    bId: r.b_id,
    kind: r.kind as RegistryRelationKind,
    source: r.source,
  }));
}

/** Is there a learned relation of `kind` between these two entries, either way? */
export function findRelation(
  aId: string,
  bId: string,
  kind: RegistryRelationKind,
): { direction: "a_to_b" | "b_to_a" } | null {
  const db = getDb();
  const ab = db
    .prepare("SELECT id FROM registry_relations WHERE a_id = ? AND b_id = ? AND kind = ?")
    .get(aId, bId, kind);
  if (ab) return { direction: "a_to_b" };
  const ba = db
    .prepare("SELECT id FROM registry_relations WHERE a_id = ? AND b_id = ? AND kind = ?")
    .get(bId, aId, kind);
  if (ba) return { direction: "b_to_a" };
  return null;
}

export function registryCounts(): Record<string, number> {
  const rows = getDb()
    .prepare("SELECT namespace, COUNT(*) n FROM registry_entries GROUP BY namespace")
    .all() as { namespace: string; n: number }[];
  return Object.fromEntries(rows.map((r) => [r.namespace, r.n]));
}
