import { NextResponse } from "next/server";
import { getFaultMode, getFaultState } from "@/lib/faults";

export const dynamic = "force-dynamic";

export function GET() {
  const mode = getFaultMode();
  const checkedAt = getFaultState().updatedAt;
  const taskUnhealthy = mode === "runtime" || mode === "persistent";
  const dependencyUnhealthy = mode === "dependency";
  return NextResponse.json({
    services: [
      { serviceId: "frontend", health: "healthy", checkedAt, detail: "TaskFlow frontend is serving." },
      {
        serviceId: "task-api",
        health: taskUnhealthy ? "unhealthy" : "healthy",
        checkedAt,
        detail: mode === "persistent"
          ? "Task API is out of memory."
          : mode === "runtime"
            ? "Task API failed its health check after the latest deployment."
            : mode === "dependency"
              ? "Task API reports the upstream dependency returned 503."
              : mode === "config"
                ? "Task API is up, but the billing config does not match the last known-good value."
                : "Task API is healthy.",
      },
      {
        serviceId: "dependency",
        health: dependencyUnhealthy ? "unhealthy" : "healthy",
        checkedAt,
        detail: dependencyUnhealthy ? "Dependency service is not accepting requests." : "Dependency service is healthy.",
      },
    ],
  });
}
