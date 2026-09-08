/**
 * Delete the database and start clean.
 *
 * Deliberately does NOT touch data/cache. The cache is the expensive artefact —
 * every model response ever paid for — and the database is derived from it.
 * Rebuilding from a warm cache takes seconds and costs nothing, which is what
 * makes iterating on the reasoning layer practical.
 */

import { existsSync, rmSync } from "node:fs";
import { DB_PATH } from "@/lib/db/client";

for (const suffix of ["", "-wal", "-shm"]) {
  const file = `${DB_PATH}${suffix}`;
  if (existsSync(file)) {
    rmSync(file);
    console.log(`removed ${file}`);
  }
}

console.log("Database cleared. data/cache/ is untouched — re-ingest replays from it for free.");
