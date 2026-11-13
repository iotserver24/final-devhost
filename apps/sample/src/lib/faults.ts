// Unified fault state for the demo target.
// - DEMO_FAULT_MODE env pins a fault (demo controls disabled while pinned).
// - Otherwise the runtime control API can inject/reset faults without restart.
// The fault label is intentionally NOT exposed through diagnosis evidence
// endpoints; only observed behavior is.

export type FaultMode = "healthy" | "runtime" | "persistent" | "dependency" | "ambiguous";
export type FaultKind = "bad-deployment" | "broken-config" | "failing-dependency" | "none";

export type FaultState = {
  mode: FaultMode;
  kind: FaultKind;
  source: "env" | "control" | "none";
  injectedAt: string | null;
  updatedAt: string;
};

function envFaultMode(): FaultMode | null {
  const mode = process.env.DEMO_FAULT_MODE;
  if (mode === "runtime" || mode === "persistent" || mode === "dependency" || mode === "ambiguous") {
    return mode;
  }
  return null;
}

// Runtime-injected fault kind (control API). Ignored while env-pinned.
let controlKind: FaultKind = "none";
let injectedAt: string | null = null;
let updatedAt = new Date().toISOString();

export function getFaultMode(): FaultMode {
  return envFaultMode() ?? "healthy";
}

export function getFaultState(): FaultState {
  return getFault();
}

export function setFaultMode(mode: FaultMode): FaultState {
  if (envFaultMode()) {
    throw new Error(`DEMO_FAULT_MODE=${envFaultMode()} is pinned by the environment; demo controls are disabled`);
  }
  // Map env-style modes onto the runtime control kinds where they overlap.
  if (mode === "runtime") return injectFault("bad-deployment");
  if (mode === "dependency") return injectFault("failing-dependency");
  if (mode === "persistent") return injectFault("broken-config");
  return resetFault();
}

export function resetFaultMode(): FaultState {
  return resetFault();
}

export function getFault(): FaultState {
  const env = envFaultMode();
  if (env) {
    return { mode: env, kind: "none", source: "env", injectedAt: null, updatedAt };
  }
  return { mode: "healthy", kind: controlKind, source: "control", injectedAt, updatedAt };
}

export function isControlPinnedByEnv(): boolean {
  return envFaultMode() !== null;
}

export function injectFault(kind: FaultKind): FaultState {
  if (envFaultMode()) {
    throw new Error(`DEMO_FAULT_MODE=${envFaultMode()} is pinned by the environment; demo controls are disabled`);
  }
  controlKind = kind;
  injectedAt = new Date().toISOString();
  updatedAt = injectedAt;
  return getFault();
}

export function resetFault(): FaultState {
  if (envFaultMode()) {
    throw new Error(`DEMO_FAULT_MODE=${envFaultMode()} is pinned by the environment; reset is disabled`);
  }
  controlKind = "none";
  injectedAt = null;
  updatedAt = new Date().toISOString();
  return getFault();
}
