import { NextResponse } from "next/server";
import { getFaultMode, tasks } from "@/lib/tasks";

export const dynamic = "force-dynamic";

export function GET() {
  const mode = getFaultMode();

  if (mode === "runtime" || mode === "persistent") {
    return NextResponse.json(
      {
        ok: false,
        error: mode === "runtime"
          ? "Demo runtime regression: task service unavailable"
          : "Demo persistent defect: task query failed",
        mode
      },
      { status: 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    count: tasks.length,
    tasks,
    timestamp: new Date().toISOString()
  });
}
