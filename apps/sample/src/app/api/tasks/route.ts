import { NextResponse } from "next/server";
import { getFaultMode, tasks } from "@/lib/tasks";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const mode = getFaultMode();

  if (mode === "runtime" || mode === "persistent" || mode === "ambiguous") {
    return NextResponse.json(
      {
        ok: false,
        error:
          mode === "runtime"
            ? "Demo runtime regression: task service unavailable"
            : mode === "persistent"
              ? "Demo persistent defect: task query failed"
              : "Demo ambiguous state: task query failed while health reports ready",
        mode
      },
      { status: 500 }
    );
  }

  if (mode === "dependency") {
    return NextResponse.json(
      {
        ok: false,
        error: "Demo dependency failure: upstream task store unreachable",
        mode
      },
      { status: 503 }
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
