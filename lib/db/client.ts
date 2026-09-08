/**
 * The single place that knows what database this is.
 *
 * Everything above this file speaks in domain objects and SQL strings; nothing
 * else imports better-sqlite3. Moving to Postgres means rewriting this file and
 * nothing else, which is the trade-off the README claims and this is the proof.
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { SCHEMA_SQL } from "./schema";

export const DATA_DIR = path.join(process.cwd(), "data");
export const DB_PATH = process.env.CROSSCHECK_DB ?? path.join(DATA_DIR, "knowledge.db");
export const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
export const CACHE_DIR = path.join(DATA_DIR, "cache");

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;

  for (const dir of [DATA_DIR, UPLOAD_DIR, CACHE_DIR]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA_SQL);
  return db;
}

/** Close the handle. Used by scripts so WAL files flush before the process exits. */
export function closeDb(): void {
  db?.close();
  db = null;
}

/** Short, sortable, human-scannable ids. Timestamp prefix keeps insertion order. */
export function newId(prefix: string): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${t}${r}`;
}

export const nowIso = () => new Date().toISOString();

/** Float32 embeddings round-trip through BLOB columns without a JSON tax. */
export function encodeEmbedding(v: number[]): Buffer {
  return Buffer.from(new Float32Array(v).buffer);
}

export function decodeEmbedding(buf: Buffer | null): number[] | null {
  if (!buf) return null;
  const f = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  return Array.from(f);
}
