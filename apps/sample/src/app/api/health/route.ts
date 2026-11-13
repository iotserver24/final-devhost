import { NextResponse } from "next/server";
import { getFaultMode } from "@/lib/tasks";

export const dynamic = "force-dynamic";

export function GET() {
  const mode = getFaultMode();

<<<<<<< Updated upstream
  // Runtime mode intentionally simulates a fresh production regression.
  if (mode === "runtime") {
=======
  if (mode === "runtime" || mode === "ambiguous") {
>>>>>>> Stashed changes
    return NextResponse.json(
      {
        ok: false,
        service: "task-manager",
        error:
          mode === "runtime"
            ? "Demo runtime regression"
            : "Demo ambiguous state: health probe reports failure while the service reports ready"
      },
      { status: 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    service: "task-manager",
    timestamp: new Date().toISOString()
  });
}
