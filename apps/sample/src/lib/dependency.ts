// Dependency service client. The task API genuinely depends on this service
// for user-facing operations: task reads are enriched by dependency status.

const DEPENDENCY_URL = process.env.DEPENDENCY_URL ?? "http://dependency:4100";

export type DependencyStatus = {
  ok: boolean;
  service: string;
  timestamp: string;
};

export async function fetchDependencyStatus(): Promise<DependencyStatus> {
  const res = await fetch(`${DEPENDENCY_URL}/health`, {
    cache: "no-store",
    signal: AbortSignal.timeout(3000)
  });
  if (!res.ok) {
    return { ok: false, service: "dependency", timestamp: new Date().toISOString() };
  }
  return (await res.json()) as DependencyStatus;
}
