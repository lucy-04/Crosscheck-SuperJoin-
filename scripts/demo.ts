/**
 * The demo: rebuild the knowledge layer from the committed cache and print the
 * four cases the assignment asks for.
 *
 *   npm run demo
 *
 * This is the reproducibility claim made executable. Because every model response
 * is cached by a hash of its prompt and that cache is committed, this runs the
 * REAL pipeline — parse, extract, ground, canonicalise, reconcile — with no API
 * key and no cost. Nothing here is a recording or a fixture.
 *
 * The four cases are FOUND, not hardcoded. The selectors below ask the reasoning
 * engine for its own highest-confidence example of each verdict; if the engine
 * stops producing one, this prints nothing for that case rather than pretending.
 */

import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { loadEnv, config } from "@/lib/env";
import { ingestPdf } from "@/lib/ingest/ingest";
import { reconcile } from "@/lib/reason/reconcile";
import {
  countFacts,
  findDocumentBySourcePath,
  getDocument,
  getFact,
  getPage,
  listQuarantine,
  listRelations,
  quarantineCounts,
  relationCounts,
} from "@/lib/db/repo";
import { registryCounts } from "@/lib/registry/store";
import { closeDb } from "@/lib/db/client";
import type { Fact, Relation } from "@/lib/types";

const BAR = "─".repeat(78);

function pdfs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...pdfs(full));
    else if (entry.toLowerCase().endsWith(".pdf")) out.push(full);
  }
  return out.sort();
}

function describe(f: Fact): string {
  const doc = getDocument(f.documentId);
  const v = f.value;
  const value = v.kind === "number" ? [v.raw, v.scale, v.currency ?? v.unit].filter(Boolean).join(" ") : v.raw;
  const scope = [f.scope.period?.raw ?? "unscoped", ...f.scope.basis].join(", ");
  return (
    `    ${f.subject} · ${f.predicate} = ${value}\n` +
    `    scope:    ${scope}\n` +
    `    source:   ${doc?.title ?? doc?.filename} p${f.evidence.pageNumber}` +
    (doc?.publishedAt ? ` (published ${doc.publishedAt})` : "")
  );
}

function evidence(f: Fact): string {
  const page = getPage(f.documentId, f.evidence.pageNumber);
  if (!page || f.evidence.charStart === null || f.evidence.charEnd === null) {
    return `    evidence: "${f.evidence.quote.slice(0, 120)}"`;
  }
  const text = page.text.slice(f.evidence.charStart, f.evidence.charEnd).replace(/\s+/g, " ").trim();
  return `    evidence: "${text.slice(0, 160)}"`;
}

function printCase(title: string, note: string, relation: Relation | undefined) {
  console.log(`\n${BAR}\n${title}\n${BAR}`);
  console.log(note + "\n");

  if (!relation) {
    console.log("  Not found in the current knowledge layer.");
    console.log("  (These are selected from the engine's output, never hardcoded, so an");
    console.log("   absence here is a real absence rather than a missing fixture.)");
    return;
  }

  const a = getFact(relation.factAId);
  const b = getFact(relation.factBId);
  if (!a || !b) return;

  console.log(`  VERDICT: ${relation.verdict}  (rule ${relation.ruleId}, confidence ${relation.confidence})`);
  if (relation.axis) console.log(`  AXIS:    ${relation.axis}`);
  console.log(`  DECIDED: ${relation.decidedBy}`);
  console.log("\n  CLAIM A");
  console.log(describe(a));
  console.log(evidence(a));
  console.log("\n  CLAIM B");
  console.log(describe(b));
  console.log(evidence(b));
  console.log("\n  REASONING");
  console.log(`    ${relation.explanation}`);
  console.log("\n  AXIS-BY-AXIS");
  for (const d of relation.deltas) {
    console.log(`    ${d.aligned ? "OK " : "-- "} ${d.dimension.padEnd(12)} ${d.note}`);
  }
}

/** Prefer a cross-document example: that is what the assignment is really about. */
function pick(verdict: string): Relation | undefined {
  const all = listRelations({ verdict, limit: 400 });
  const cross = all.filter((r) => {
    const a = getFact(r.factAId);
    const b = getFact(r.factBId);
    return a && b && a.documentId !== b.documentId;
  });
  return cross[0] ?? all[0];
}

async function main() {
  loadEnv();

  console.log(`${BAR}\nCROSSCHECK — rebuilding the knowledge layer\n${BAR}`);
  console.log(`Model: ${config.model}   Provider key: ${config.hasApiKey ? "present" : "absent (cache only)"}`);
  console.log("Every model response is read from data/cache/, so this costs nothing.\n");

  const files = pdfs("starter-datasets");
  for (const file of files) {
    const existing = findDocumentBySourcePath(file);
    if (existing && existing.status === "ingested") {
      console.log(`  = ${path.basename(file)} (already ingested)`);
      continue;
    }

    // Check cache coverage BEFORE ingesting. Without this the demo would try to
    // call a model for any uncached document, which breaks the promise that it
    // runs for free with no key — and on a rate-limited tier it would grind for
    // many minutes before failing. Skipping loudly is the honest behaviour.
    const coverage = await cacheCoverage(file);
    if (coverage.fraction < MIN_COVERAGE) {
      console.log(
        `  - ${path.basename(file)} SKIPPED — only ${Math.round(coverage.fraction * 100)}% ` +
          `of its ${coverage.total} pages are in the committed cache.`,
      );
      skipped.push(path.basename(file));
      continue;
    }

    process.stdout.write(`  + ${path.basename(file)} … `);
    try {
      const { stats } = await ingestPdf(file, { force: true });
      console.log(`${stats.facts} facts, ${stats.quarantined} quarantined, ${stats.seconds}s`);
    } catch (err) {
      console.log(`skipped (${err instanceof Error ? err.message.split("\n")[0] : String(err)})`);
      skipped.push(path.basename(file));
    }
  }

  if (skipped.length) {
    console.log(
      `\n  Note: ${skipped.length} document(s) are not in the cache and were skipped:\n` +
        skipped.map((s) => `    - ${s}`).join("\n") +
        `\n  Ingest them with a provider key: npm run ingest -- --all`,
    );
  }

  console.log("\nReconciling …");
  const stats = await reconcile({ fresh: true });
  console.log(
    `  ${stats.canonicalised} facts canonicalised · ${stats.blocks} blocks · ` +
      `${stats.pairsCompared} pairs compared · ${stats.relationsStored} relations · ${stats.seconds}s`,
  );

  const quarantined = Object.values(quarantineCounts()).reduce((a, b) => a + b, 0);
  const facts = countFacts();
  console.log(
    `\nStore: ${facts} grounded facts · ${quarantined} quarantined ` +
      `(${Math.round((facts / Math.max(1, facts + quarantined)) * 100)}% grounding rate)`,
  );
  console.log(`Vocabulary: ${JSON.stringify(registryCounts())}`);
  console.log(`Verdicts:   ${JSON.stringify(relationCounts())}`);

  printCase(
    "CASE 1 — A fact corroborated across documents, expressed differently",
    "Two sources state the same thing for the same scope. Wording, units and scale\n" +
      "may differ; after normalisation the values agree and every axis lines up.",
    pick("CORROBORATES"),
  );

  printCase(
    "CASE 2 — A genuine or likely contradiction",
    "Same subject, measure, period, entity scope, basis and unit — and still different\n" +
      "values. Every reconciling hypothesis was tried and none fits.",
    pick("CONTRADICTS"),
  );

  printCase(
    "CASE 3 — An apparent contradiction explained by context",
    "The values differ, but so does the scope, and the engine names which axis accounts\n" +
      "for the gap rather than simply labelling the pair.",
    pick("RECONCILED") ?? pick("SUPERSEDED"),
  );

  // Case 4 is not a relation but a failure, so it is drawn from quarantine —
  // the extractions the grounding check refused to store.
  console.log(`\n${BAR}\nCASE 4 — An extraction or reasoning failure, and how it is handled\n${BAR}`);
  const reasons = quarantineCounts();
  console.log("Grounding rejects any claim whose quote cannot be found on the page it cites,");
  console.log("or whose value does not appear inside that quote. Rejected claims are kept and");
  console.log("counted rather than deleted, so the error rate is measured rather than asserted.\n");
  console.log(`  Rejections by reason: ${JSON.stringify(reasons)}\n`);

  for (const q of listQuarantine(undefined, 400).slice(0, 3)) {
    const doc = getDocument(q.documentId);
    const raw = (q.claim.value as { raw?: string }).raw ?? "";
    console.log(`  [${q.reason}] ${q.claim.subject} · ${q.claim.predicate} = ${raw}`);
    console.log(`     cited quote: ${JSON.stringify(q.claim.evidence.quote.slice(0, 100))}`);
    console.log(`     source:      ${doc?.title ?? doc?.filename} p${q.pageNumber}`);
    console.log(`     handling:    dropped before reasoning; visible at /quarantine\n`);
  }

  console.log(`${BAR}\nRun \`npm run dev\` to explore this interactively.\n${BAR}`);
  closeDb();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
