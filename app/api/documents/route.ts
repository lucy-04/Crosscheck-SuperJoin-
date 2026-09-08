/**
 * Documents: list, and upload a new PDF.
 *
 * The upload path runs the full ingest inline rather than returning a job id.
 * That is a deliberate simplification for a prototype — it keeps the API honest
 * (when it returns, the facts are queryable) at the cost of a long request. A
 * production version would hand back a job id and stream progress.
 */

import { NextResponse } from "next/server";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { UPLOAD_DIR, newId } from "@/lib/db/client";
import { listDocuments } from "@/lib/db/repo";
import { ingestPdf } from "@/lib/ingest/ingest";
import { MissingApiKeyError } from "@/lib/extract/extract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 3600;

export async function GET() {
  return NextResponse.json({ documents: listDocuments() });
}

export async function POST(request: Request) {
  const form = await request.formData();
  const file = form.get("file");

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Expected a 'file' field containing a PDF" }, { status: 400 });
  }
  if (!file.name.toLowerCase().endsWith(".pdf")) {
    return NextResponse.json({ error: "Only PDF files are supported" }, { status: 415 });
  }

  // Uploads are copied under data/uploads so the evidence viewer can still reach
  // the source after the request ends.
  const safe = file.name.replace(/[^\w.\-]+/g, "_");
  const target = path.join(UPLOAD_DIR, `${newId("up")}_${safe}`);
  await writeFile(target, Buffer.from(await file.arrayBuffer()));

  try {
    const { documentId, stats } = await ingestPdf(target, { force: true });
    return NextResponse.json({ documentId, stats });
  } catch (err) {
    if (err instanceof MissingApiKeyError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
