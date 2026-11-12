import { NextRequest, NextResponse } from "next/server";
import { getFault, injectFault, resetFault, FaultKind } from "@/lib/faults";

export const dynamic = "force-dynamic";

const VALID: FaultKind[] = ["bad-deployment", "broken-config", "failing-dependency"];

// GET /api/faults -> current fault state incl. injection timestamp (kept separate
// from Sentinel's detection time)
export function GET() {
  return NextResponse.json(getFault());
}

// POST /api/faults  { "kind": "bad-deployment" | "broken-config" | "failing-dependency" }
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || !VALID.includes(body.kind)) {
    return NextResponse.json({ ok: false, error: "kind must be one of " + VALID.join(", ") }, { status: 400 });
  }
  return NextResponse.json(injectFault(body.kind));
}

// DELETE /api/faults -> reset to verified known-good state
export function DELETE() {
  return NextResponse.json(resetFault());
}
