import { NextResponse } from "next/server";
import { listFacts } from "@/lib/db/repo";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  const facts = listFacts({
    documentId: q.get("documentId") ?? undefined,
    factType: q.get("factType") ?? undefined,
    predicateId: q.get("predicateId") ?? undefined,
    search: q.get("q") ?? undefined,
    limit: Number(q.get("limit") ?? 200),
    offset: Number(q.get("offset") ?? 0),
  });
  return NextResponse.json({ count: facts.length, facts });
}
