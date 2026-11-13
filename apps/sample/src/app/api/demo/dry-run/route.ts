import { NextResponse } from "next/server";
import { runDryRun } from "@/lib/policy";
import {
  authorizeDemoMutation,
  demoControlsEnabled,
  demoDisabledResponse,
  demoUnauthorizedResponse
} from "@/lib/demo-guard";

export const dynamic = "force-dynamic";

// Dry-run control backed by the real policy evaluation. It probes the live
// services and never changes the fault mode or any other target state.
export async function POST(request: Request) {
  if (!demoControlsEnabled()) return demoDisabledResponse();
  if (!authorizeDemoMutation(request)) return demoUnauthorizedResponse();

  const host = request.headers.get("host") ?? "localhost:3000";
  const origin = `http://${host}`;

  const report = await runDryRun(origin);
  return NextResponse.json({ ok: true, report });
}

export function GET() {
  return NextResponse.json({
    ok: true,
    demo: true,
    dryRun: true,
    controlsEnabled: demoControlsEnabled(),
    note: "POST to this endpoint to evaluate the policy against live service probes. It never changes the target."
  });
}
