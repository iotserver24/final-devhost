import { NextResponse } from "next/server";
import { getFaultMode } from "@/lib/tasks";
import { getFault } from "@/lib/faults";

export const dynamic = "force-dynamic";

export function GET() {
  const fault = getFault();
  const mode = getFaultMode();

  if (fault.kind === "bad-deployment" || mode === "runtime") {
    return NextResponse.json(
      { ok: false, service: "task-manager", error: "Current revision fails its probe" },
      { status: 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    service: "task-manager",
    fault: fault.kind,
    timestamp: new Date().toISOString()
  });
}
