import { NextResponse } from "next/server";
import { createTask, tasks, ValidationError, type CreateTaskInput } from "@/lib/tasks";
import { fetchDependencyStatus } from "@/lib/dependency";
import { getFault, getFaultMode } from "@/lib/faults";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const fault = getFault();
  const mode = getFaultMode();

  // Bad deployment: current revision broken
  if (fault.kind === "bad-deployment" || mode === "runtime") {
    return NextResponse.json(
      { ok: false, error: "Current revision fails its probe" },
      { status: 500 }
    );
  }

  if (mode === "persistent" || mode === "ambiguous") {
    return NextResponse.json(
      { ok: false, error: mode === "persistent" ? "Demo persistent defect: task query failed" : "Demo ambiguous state: task query failed while health reports ready", mode },
      { status: 500 }
    );
  }

  // Failing dependency: dependency unreachable -> task API reports dependency error
  if (fault.kind === "failing-dependency" || mode === "dependency") {
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

  // Genuinely depend on the dependency service for the user-facing operation
  const dep = await fetchDependencyStatus();
  if (!dep.ok) {
    return NextResponse.json(
      { ok: false, error: "Dependency service unreachable", dependency: "down" },
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
    dependency: dep,
    timestamp: new Date().toISOString()
  });
}

export async function POST(request: Request) {
  const mode = getFaultMode();
  const fault = getFault();

  if (fault.kind === "bad-deployment" || mode === "runtime" || mode === "persistent" || mode === "ambiguous") {
    return NextResponse.json(
      { ok: false, error: "Task service unavailable in the current demo fault mode", mode },
      { status: 500 }
    );
  }
  if (fault.kind === "failing-dependency" || mode === "dependency") {
    return NextResponse.json(
      { ok: false, error: "Demo dependency failure: upstream task store unreachable", mode },
      { status: 503 }
    );
  }

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Request body must be JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ ok: false, error: "Request body must be a JSON object" }, { status: 400 });
  }

  try {
    const task = createTask(body as CreateTaskInput);
    return NextResponse.json({ ok: true, task }, { status: 201 });
  } catch (error) {
    if (error instanceof ValidationError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
    }
    throw error;
  }
}
