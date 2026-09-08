import { NextResponse } from "next/server";
import { getFact, getPage, listRelationsForFact } from "@/lib/db/repo";

export const dynamic = "force-dynamic";

/** A fact with everything needed to verify it: its evidence and its relations. */
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const fact = getFact(id);
  if (!fact) return NextResponse.json({ error: "No such fact" }, { status: 404 });

  const page = getPage(fact.documentId, fact.evidence.pageNumber);
  return NextResponse.json({
    fact,
    evidence: {
      pageNumber: fact.evidence.pageNumber,
      quote: fact.evidence.quote,
      charStart: fact.evidence.charStart,
      charEnd: fact.evidence.charEnd,
      pageText: page?.text ?? null,
    },
    relations: listRelationsForFact(id),
  });
}
