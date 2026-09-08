import { NextResponse } from "next/server";
import { reconcile } from "@/lib/reason/reconcile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 3600;

/**
 * Re-run canonicalisation and reasoning.
 *
 * Incremental by default: only facts that have never been canonicalised are
 * resolved, and only blocks containing more than one fact are compared. Pass
 * `{ "fresh": true }` to discard existing relations and redecide everything,
 * which is what you want after changing a verdict rule.
 */
export async function POST(request: Request) {
  let fresh = false;
  try {
    const body = await request.json();
    fresh = Boolean(body?.fresh);
  } catch {
    // No body is fine; incremental is the default.
  }

  try {
    const stats = await reconcile({ fresh });
    return NextResponse.json({ stats });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
