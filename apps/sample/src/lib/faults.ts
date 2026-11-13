export type FaultMode = "healthy" | "runtime" | "persistent" | "dependency" | "config" | "ambiguous";

export type FaultState = {
  mode: FaultMode;
  source: "env" | "control";
  updatedAt: string;
};

function envFaultMode(): FaultMode | null {
  const mode = process.env.DEMO_FAULT_MODE;
  if (mode === "runtime" || mode === "persistent" || mode === "dependency" || mode === "config" || mode === "ambiguous") {
    return mode;
  }
  return null;
}

// In-memory fault set through the local demo control API. Ignored while a
// fault is pinned through DEMO_FAULT_MODE.
let controlMode: FaultMode = "healthy";
let updatedAt = new Date().toISOString();

export function getFaultMode(): FaultMode {
  return envFaultMode() ?? controlMode;
}

export function getFaultState(): FaultState {
  const env = envFaultMode();
  return env
    ? { mode: env, source: "env", updatedAt }
    : { mode: controlMode, source: "control", updatedAt };
}

export function isControlPinnedByEnv(): boolean {
  return envFaultMode() !== null;
}

export function setFaultMode(mode: FaultMode): FaultState {
  const env = envFaultMode();
  if (env) {
    throw new Error(
      `DEMO_FAULT_MODE=${env} is pinned by the environment; demo controls are disabled`
    );
  }
  controlMode = mode;
  updatedAt = new Date().toISOString();
  return getFaultState();
}

export function resetFaultMode(): FaultState {
  const env = envFaultMode();
  if (env) {
    throw new Error(
      `DEMO_FAULT_MODE=${env} is pinned by the environment; reset is disabled`
    );
  }
  controlMode = "healthy";
  updatedAt = new Date().toISOString();
  return getFaultState();
}
