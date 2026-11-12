import { NextResponse } from "next/server";
import { getFaultMode, tasks } from "@/lib/tasks";
import { fetchDependencyStatus } from "@/lib/dependency";
import { getFault } from "@/lib/faults";

export const dynamic = "force-dynamic";

export async function GET() {
  const fault = getFault();
  const mode = getFaultMode();

  // Bad deployment: current revision broken
  if (fault.kind === "bad-deployment" || mode === "runtime") {
    return NextResponse.json(
      { ok: false, error: "Current revision fails its probe" },
      { status: 500 }
    );
  }

  // Failing dependency: dependency unreachable -> task API reports dependency error
  if (fault.kind === "failing-dependency") {
    return NextResponse.json(
      { ok: false, error: "Dependency service unreachable", dependency: "down" },
      { status: 503 }
    );
  }

  // Broken config: invalid allowlisted value applied
  if (fault.kind === "broken-config") {
    return NextResponse.json(
      { ok: false, error: "Invalid configuration value for task page size" },
      { status: 500 }
    );
  }

  if (mode === "persistent") {
    return NextResponse.json(
      { ok: false, error: "Demo persistent defect: task query failed", mode },
      { status: 500 }
    );
  }

  // Genuinely depend on the dependency service for the user-facing operation
  const dep = await fetchDependencyStatus();
  if (!dep.ok) {
    return NextResponse.json(
      { ok: false, error: "Dependency service unreachable", dependency: "down" },
      { status: 503 }
    );
  }

  return NextResponse.json({
    ok: true,
    count: tasks.length,
    tasks,
    dependency: dep,
    timestamp: new Date().toISOString()
  });
}
