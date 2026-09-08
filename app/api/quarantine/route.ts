import { NextResponse } from "next/server";
import { countFacts, listQuarantine, quarantineCounts } from "@/lib/db/repo";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  const counts = quarantineCounts();
  const rejected = Object.values(counts).reduce((a, b) => a + b, 0);
  const kept = countFacts();
  return NextResponse.json({
    counts,
    kept,
    rejected,
    groundingRate: kept + rejected ? kept / (kept + rejected) : null,
    items: listQuarantine(q.get("documentId") ?? undefined, Number(q.get("limit") ?? 200)),
  });
}
