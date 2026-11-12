import { tasks } from "@/lib/tasks";

export const dynamic = "force-dynamic";

export function GET() {
  const missing = tasks.find((task) => task.id === 0);
  if (!missing) throw new Error("Task service failed while reading a task.");
  return Response.json({ ok: true, status: missing.status });
}
