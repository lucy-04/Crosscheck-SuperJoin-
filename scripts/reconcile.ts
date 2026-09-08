/**
 * Run canonicalisation and reconciliation over everything currently stored.
 *
 *   npm run reconcile             # incremental: only new facts and their blocks
 *   npm run reconcile -- --fresh  # discard existing relations and redecide
 */

import { loadEnv, config } from "@/lib/env";
import { reconcile } from "@/lib/reason/reconcile";
import { registryCounts } from "@/lib/registry/store";
import { countFacts, relationCounts } from "@/lib/db/repo";
import { closeDb } from "@/lib/db/client";

async function main() {
  loadEnv();
  const fresh = process.argv.includes("--fresh");

  console.log(`Model: ${config.model}  ·  facts in store: ${countFacts()}`);
  console.log(fresh ? "Rebuilding all relations\n" : "Incremental pass\n");

  let lastPhase = "";
  const stats = await reconcile({
    fresh,
    onProgress: (phase, done, total) => {
      if (phase !== lastPhase) {
        if (lastPhase) process.stdout.write("\n");
        lastPhase = phase;
      }
      if (done % 25 === 0 || done === total) {
        process.stdout.write(`\r   ${phase}: ${done}/${total}   `);
      }
    },
  });
  process.stdout.write("\n\n");

  console.log(`canonicalised ${stats.canonicalised} facts`);
  console.log(`registry:     ${JSON.stringify(registryCounts())}`);
  console.log(`blocks:       ${stats.blocks}`);
  console.log(`pairs:        ${stats.pairsCompared}`);
  console.log(`relations:    ${stats.relationsStored}`);
  console.log(`by verdict:   ${JSON.stringify(relationCounts())}`);
  console.log(`took:         ${stats.seconds}s`);

  closeDb();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
