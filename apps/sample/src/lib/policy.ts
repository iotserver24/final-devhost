import { getFaultMode } from "@/lib/faults";

export type ServiceId = "health" | "tasks" | "summary";

export type ProbeResult = {
  service: ServiceId;
  reachable: boolean;
  healthy: boolean;
  status: number | null;
  error: string | null;
  checkedAt: string;
};

export type DryRunOutcome = {
  allowed: boolean;
  reason: string;
  targetChanged: false;
};

export type DryRunReport = {
  demo: true;
  dryRun: true;
  faultMode: string;
  probes: ProbeResult[];
  outcome: DryRunOutcome;
  evaluatedAt: string;
};

// Classifies one probe response without ever mutating state.
export function classifyProbe(
  service: ServiceId,
  status: number | null,
  error: string | null
): ProbeResult {
  const reachable = status !== null;
  return {
    service,
    reachable,
    healthy: reachable && status >= 200 && status < 300,
    status,
    error,
    checkedAt: new Date().toISOString()
  };
}

async function probeService(
  origin: string,
  service: ServiceId,
  path: string
): Promise<ProbeResult> {
  try {
    const response = await fetch(`${origin}${path}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(5000)
    });
    return classifyProbe(service, response.status, null);
  } catch (error) {
    return classifyProbe(
      service,
      null,
      error instanceof Error ? error.message : "Unknown probe error"
    );
  }
}

// BE2's real policy evaluation for a dry run: the target must not change, and
// the decision is derived from the live probe results, not from a simulated
// status. An unreachable service is treated as not healthy.
export function evaluatePolicy(probes: ProbeResult[]): DryRunOutcome {
  const failed = probes.filter((probe) => !probe.healthy);
  if (failed.length === 0) {
    return {
      allowed: true,
      reason: "All services reachable and healthy; no fault impact detected.",
      targetChanged: false
    };
  }
  const unreachable = failed.filter((probe) => !probe.reachable);
  const failing = failed.filter((probe) => probe.reachable);
  const parts: string[] = [];
  if (failing.length > 0) {
    parts.push(
      `failing: ${failing.map((probe) => `${probe.service} (HTTP ${probe.status})`).join(", ")}`
    );
  }
  if (unreachable.length > 0) {
    parts.push(`unreachable: ${unreachable.map((probe) => probe.service).join(", ")}`);
  }
  return {
    allowed: false,
    reason: `Fault impact detected — ${parts.join("; ")}. Dry run only; target unchanged.`,
    targetChanged: false
  };
}

// Probes the app's own API routes server-side and evaluates the policy.
// Read-only: it never calls setFaultMode/resetFaultMode.
export async function runDryRun(origin: string): Promise<DryRunReport> {
  const probes = await Promise.all([
    probeService(origin, "health", "/api/health"),
    probeService(origin, "tasks", "/api/tasks"),
    probeService(origin, "summary", "/api/tasks/summary")
  ]);
  return {
    demo: true,
    dryRun: true,
    faultMode: getFaultMode(),
    probes,
    outcome: evaluatePolicy(probes),
    evaluatedAt: new Date().toISOString()
  };
}
