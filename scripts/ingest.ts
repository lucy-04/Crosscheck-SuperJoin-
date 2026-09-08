/**
 * CLI ingest.
 *
 *   npm run ingest starter-datasets/delhivery/03-...pdf
 *   npm run ingest -- --all          # every PDF under starter-datasets/
 *   npm run ingest -- --all --force  # re-ingest, replacing existing records
 */

import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { loadEnv, config } from "@/lib/env";
import { ingestPdf } from "@/lib/ingest/ingest";
import { closeDb } from "@/lib/db/client";
import { MissingApiKeyError } from "@/lib/extract/extract";

function findPdfs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...findPdfs(full));
    else if (entry.toLowerCase().endsWith(".pdf")) out.push(full);
  }
  return out.sort();
}

async function main() {
  loadEnv();
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const all = args.includes("--all");
  const files = all
    ? findPdfs("starter-datasets")
    : args.filter((a) => !a.startsWith("--"));

  if (!files.length) {
    console.error("Usage: npm run ingest <file.pdf> [...]  |  npm run ingest -- --all [--force]");
    process.exit(1);
  }

  console.log(`Model: ${config.model}   Concurrency: ${config.concurrency}   Key: ${config.hasApiKey ? "set" : "NOT SET (cache only)"}`);
  console.log(`Ingesting ${files.length} document(s)\n`);

  for (const file of files) {
    console.log(`── ${path.basename(file)}`);
    try {
      let lastPct = -1;
      const { stats } = await ingestPdf(file, {
        force,
        onStage: (stage, detail) => {
          if (stage !== "extract") console.log(`   ${stage}${detail ? `: ${detail}` : ""}`);
          else console.log(`   extract: ${detail}`);
        },
        onProgress: (done, total, cache) => {
          const pct = Math.floor((done / total) * 100);
          // Only redraw on whole-percent changes; 700 lines of progress is noise.
          if (pct !== lastPct && pct % 5 === 0) {
            lastPct = pct;
            process.stdout.write(`\r   ${pct}%  ${done}/${total}  ${cache}   `);
          }
        },
      });
      process.stdout.write("\r");
      console.log(
        `   ✓ ${stats.facts} facts · ${stats.quarantined} quarantined · ` +
          `${stats.units} units (${stats.unitsSkipped} skipped) · ` +
          `cache ${stats.cacheHits}/${stats.cacheHits + stats.cacheMisses} · ${stats.seconds}s\n`,
      );
    } catch (err) {
      if (err instanceof MissingApiKeyError) {
        console.error(`\n${err.message}\n`);
        process.exit(2);
      }
      console.error(`   ✗ ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  closeDb();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
