import { NextResponse } from "next/server";
import { createTask, getFaultMode, tasks, ValidationError, type CreateTaskInput } from "@/lib/tasks";

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

export async function POST(request: Request) {
  const mode = getFaultMode();

  if (mode === "runtime" || mode === "persistent" || mode === "ambiguous") {
    return NextResponse.json(
      { ok: false, error: "Task service unavailable in the current demo fault mode", mode },
      { status: 500 }
    );
  }
  if (mode === "dependency") {
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
