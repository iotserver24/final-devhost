import { NextResponse } from "next/server";
import { projects } from "@/lib/projects";
import { tasks } from "@/lib/tasks";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({
    ok: true,
    projects: projects.map((project) => ({
      ...project,
      taskCount: tasks.filter((task) => task.projectId === project.id).length
    }))
  });
}
