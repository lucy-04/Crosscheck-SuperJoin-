import { NextResponse } from "next/server";
import { getDocument } from "@/lib/db/repo";

export const dynamic = "force-dynamic";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const doc = getDocument(id);
  if (!doc) return NextResponse.json({ error: "No such document" }, { status: 404 });
  return NextResponse.json({ id: doc.id, status: doc.status, stats: doc.stats });
}
