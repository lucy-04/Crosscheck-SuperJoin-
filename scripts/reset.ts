/**
 * Clear the knowledge layer and start fresh.
 *
 * Deletes ROWS, not the database file. That distinction matters: unlinking the
 * file leaves any already-running process (a `npm run dev` server, say) holding
 * an open handle to the now-deleted inode, so it keeps serving the old data
 * while the CLI populates a brand-new file at the same path. Two processes, two
 * different databases, one filename — and a UI that shows numbers nobody can
 * reproduce.
 *
 * Deliberately does NOT touch data/cache. The cache is the expensive artefact —
 * every model response ever paid for — and the database is derived from it.
 * Rebuilding from a warm cache takes about a second and costs nothing, which is
 * what makes iterating on the reasoning layer practical.
 */

import { closeDb, getDb } from "@/lib/db/client";

const db = getDb();

// Order matters only for readability; foreign keys cascade from documents.
const TABLES = [
  "relations",
  "quarantine",
  "facts",
  "units",
  "pages",
  "documents",
  "registry_relations",
  "registry_entries",
];

const before = (db.prepare("SELECT COUNT(*) n FROM facts").get() as { n: number }).n;

db.transaction(() => {
  for (const table of TABLES) db.prepare(`DELETE FROM ${table}`).run();
})();

// Reclaim the space so the file does not grow without bound across rebuilds.
db.exec("VACUUM");

console.log(`Cleared ${before} facts and all derived rows.`);
console.log("data/cache/ is untouched — re-ingest replays from it for free.");
console.log("Any running `npm run dev` server will pick this up on its next request.");

closeDb();
