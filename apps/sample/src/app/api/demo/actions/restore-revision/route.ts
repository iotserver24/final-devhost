import { NextResponse } from "next/server";
import { authorizeDemoMutation, demoControlsEnabled, demoDisabledResponse, demoUnauthorizedResponse } from "@/lib/demo-guard";
import { resetFaultMode } from "@/lib/faults";

export const dynamic = "force-dynamic";

export function POST(request: Request) {
  if (!demoControlsEnabled()) return demoDisabledResponse();
  if (!authorizeDemoMutation(request)) return demoUnauthorizedResponse();
  return NextResponse.json({ ok: true, state: resetFaultMode() });
}
