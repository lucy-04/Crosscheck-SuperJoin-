import { NextResponse } from "next/server";
import { listAllRelations, listEntries, registryCounts } from "@/lib/registry/store";

export const dynamic = "force-dynamic";

/** The evolving schema, as data. Embeddings are omitted; they are large and internal. */
export async function GET() {
  const entries = listEntries().map(({ embedding, ...rest }) => rest);
  return NextResponse.json({
    counts: registryCounts(),
    entries,
    relations: listAllRelations(),
  });
}
