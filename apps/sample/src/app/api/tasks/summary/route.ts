import { NextResponse } from "next/server";
import { tasks } from "@/lib/tasks";

export const dynamic = "force-dynamic";

export function GET() {
  const summary = {
    total: tasks.length,
    todo: tasks.filter((task) => task.status === "Todo").length,
    inProgress: tasks.filter((task) => task.status === "In progress").length,
    done: tasks.filter((task) => task.status === "Done").length
  };

  return NextResponse.json({ ok: true, summary });
}
