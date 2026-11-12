import { NextResponse } from "next/server";
import { getFaultMode } from "@/lib/tasks";

export const dynamic = "force-dynamic";

export function GET() {
  const mode = getFaultMode();

  // Runtime mode intentionally simulates a fresh production regression.
  if (mode === "runtime") {
    return NextResponse.json(
      { ok: false, service: "task-manager", error: "Demo runtime regression" },
      { status: 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    service: "task-manager",
    timestamp: new Date().toISOString()
  });
}
