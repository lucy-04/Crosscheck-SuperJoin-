/**
 * Throwaway smoke check: does PDF parsing produce usable text and coordinates on
 * the real starter documents, and does SQLite open? Run before building on top of
 * either. Deleted once the ingest pipeline covers this ground.
 */
import { readFileSync } from "node:fs";
import { parsePdf } from "@/lib/ingest/parse";
import { segmentDocument, renderUnitForPrompt } from "@/lib/ingest/segment";
import { getDb } from "@/lib/db/client";

const file = process.argv[2] ?? "starter-datasets/delhivery/03-delhivery-q4-fy24-earnings-presentation.pdf";

async function main() {
  const db = getDb();
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as { name: string }[];
  console.log("SQLite OK — tables:", tables.map((t) => t.name).join(", "));

  console.time("parse");
  const data = new Uint8Array(readFileSync(file));
  const doc = await parsePdf(data);
  console.timeEnd("parse");

  console.log(`\ntitle=${JSON.stringify(doc.title)} published=${doc.publishedAt} pages=${doc.pageCount}`);

  const withText = doc.pages.filter((p) => p.text.trim().length > 50).length;
  console.log(`pages with real text: ${withText}/${doc.pageCount}`);
  const totalChars = doc.pages.reduce((n, p) => n + p.text.length, 0);
  const totalSpans = doc.pages.reduce((n, p) => n + p.spans.length, 0);
  console.log(`chars=${totalChars} spans=${totalSpans}`);

  const { units, skipped } = segmentDocument(doc.pages, doc.title);
  console.log(`units=${units.length} skipped(non-salient)=${skipped}`);

  // Show the densest unit — the one most likely to be a financial table.
  const densest = [...units]
    .filter((u) => u.salient)
    .sort((a, b) => (b.text.match(/\d/g)?.length ?? 0) - (a.text.match(/\d/g)?.length ?? 0))[0];
  console.log("\n----- densest unit as the model will see it -----");
  console.log(renderUnitForPrompt(densest).slice(0, 1800));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
