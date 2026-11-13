import { NextResponse } from "next/server";
import {
  getFaultState,
  isControlPinnedByEnv,
  resetFaultMode,
  setFaultMode,
  type FaultMode
} from "@/lib/faults";
import {
  authorizeDemoMutation,
  demoControlsEnabled,
  demoDisabledResponse,
  demoUnauthorizedResponse
} from "@/lib/demo-guard";

export const dynamic = "force-dynamic";

const MODES: FaultMode[] = ["healthy", "runtime", "persistent", "dependency", "ambiguous"];

// Read-only state endpoint: safe to expose without the control token.
export function GET() {
  return NextResponse.json({
    ok: true,
    demo: true,
    state: getFaultState(),
    modes: MODES,
    pinnedByEnv: isControlPinnedByEnv(),
    controlsEnabled: demoControlsEnabled()
  });
}

export async function POST(request: Request) {
  if (!demoControlsEnabled()) return demoDisabledResponse();
  if (!authorizeDemoMutation(request)) return demoUnauthorizedResponse();

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Request body must be JSON" },
      { status: 400 }
    );
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json(
      { ok: false, error: "Request body must be a JSON object" },
      { status: 400 }
    );
  }
  const { action, mode } = body as { action?: string; mode?: string };

  try {
    if (action === "reset") {
      return NextResponse.json({ ok: true, demo: true, state: resetFaultMode() });
    }
    if (action === "set") {
      if (!MODES.includes(mode as FaultMode)) {
        return NextResponse.json(
          { ok: false, error: `mode must be one of: ${MODES.join(", ")}` },
          { status: 400 }
        );
      }
      return NextResponse.json({
        ok: true,
        demo: true,
        state: setFaultMode(mode as FaultMode)
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
