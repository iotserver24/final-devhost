import { NextResponse } from "next/server";
import { getFaultMode, tasks } from "@/lib/tasks";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
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

  const status = new URL(request.url).searchParams.get("status");
  const selected = status
    ? tasks.filter((task) => task.status.toLowerCase() === status.toLowerCase())
    : tasks;
  return NextResponse.json({
    ok: true,
    count: selected.length,
    tasks: selected,
    timestamp: new Date().toISOString()
  });
}
