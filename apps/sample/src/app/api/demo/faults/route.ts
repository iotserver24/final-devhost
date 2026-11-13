import { NextResponse } from "next/server";
import {
  getFaultState,
  isControlPinnedByEnv,
  resetFaultMode,
  setFaultMode,
  type FaultMode
} from "@/lib/faults";
import { demoForbiddenResponse, isDemoRequest } from "@/lib/demo-guard";

export const dynamic = "force-dynamic";

const MODES: FaultMode[] = ["healthy", "runtime", "persistent", "dependency", "ambiguous"];

export function GET(request: Request) {
  if (!isDemoRequest(request)) return demoForbiddenResponse();
  return NextResponse.json({
    ok: true,
    demo: true,
    state: getFaultState(),
    modes: MODES,
    pinnedByEnv: isControlPinnedByEnv()
  });
}

export async function POST(request: Request) {
  if (!isDemoRequest(request)) return demoForbiddenResponse();

  let body: { action?: string; mode?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Request body must be JSON" },
      { status: 400 }
    );
  }

  try {
    if (body.action === "reset") {
      return NextResponse.json({ ok: true, demo: true, state: resetFaultMode() });
    }
    if (body.action === "set") {
      if (!MODES.includes(body.mode as FaultMode)) {
        return NextResponse.json(
          { ok: false, error: `mode must be one of: ${MODES.join(", ")}` },
          { status: 400 }
        );
      }
      return NextResponse.json({
        ok: true,
        demo: true,
        state: setFaultMode(body.mode as FaultMode)
      });
    }
    return NextResponse.json(
      { ok: false, error: "action must be 'set' or 'reset'" },
      { status: 400 }
    );
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Unknown error" },
      { status: 409 }
    );
  }
}
