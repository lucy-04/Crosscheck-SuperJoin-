import { NextResponse } from "next/server";
import { listRelations, relationCounts } from "@/lib/db/repo";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  return NextResponse.json({
    counts: relationCounts(),
    relations: listRelations({
      verdict: q.get("verdict") ?? undefined,
      limit: Number(q.get("limit") ?? 200),
    }),
  });
}
