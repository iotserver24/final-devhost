import { NextResponse } from "next/server";
import { deleteTask, getFaultMode, updateTask, ValidationError, type UpdateTaskInput } from "@/lib/tasks";

export const dynamic = "force-dynamic";

function faultResponse(mode: string) {
  const dependency = mode === "dependency";
  return NextResponse.json(
    {
      ok: false,
      error: dependency
        ? "Demo dependency failure: upstream task store unreachable"
        : "Task service unavailable in the current demo fault mode",
      mode
    },
    { status: dependency ? 503 : 500 }
  );
}

function parseId(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  return Number(raw);
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const mode = getFaultMode();
  if (mode !== "healthy") return faultResponse(mode);

  const { id } = await params;
  const taskId = parseId(id);
  if (taskId === null) {
    return NextResponse.json({ ok: false, error: "Task id must be a number" }, { status: 400 });
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
    const task = updateTask(taskId, body as UpdateTaskInput);
    if (!task) {
      return NextResponse.json({ ok: false, error: "Task not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, task });
  } catch (error) {
    if (error instanceof ValidationError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
    }
    throw error;
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const mode = getFaultMode();
  if (mode !== "healthy") return faultResponse(mode);

  const { id } = await params;
  const taskId = parseId(id);
  if (taskId === null) {
    return NextResponse.json({ ok: false, error: "Task id must be a number" }, { status: 400 });
  }
  if (!deleteTask(taskId)) {
    return NextResponse.json({ ok: false, error: "Task not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
