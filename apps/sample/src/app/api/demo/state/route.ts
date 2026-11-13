import { NextResponse } from "next/server";
import { getFaultMode, getFaultState } from "@/lib/faults";

export const dynamic = "force-dynamic";

export function GET() {
  const mode = getFaultMode();
  const state = getFaultState();
  return NextResponse.json({
    activeFault: mode === "runtime" ? "bad_deployment"
      : mode === "dependency" ? "dependency_down"
      : mode === "persistent" ? "resource_exhaustion"
      : mode === "config" ? "bad_config"
      : mode === "ambiguous" ? "ambiguous"
      : undefined,
    faultInjectedAt: mode === "healthy" ? undefined : state.updatedAt,
    knownGoodRevision: mode === "runtime" ? "good-rev" : undefined,
    knownGoodConfig: mode === "config" ? { BILLING_MODE: "invoice" } : undefined,
  });
}
