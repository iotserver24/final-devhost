// Runtime fault injection state for the demo target.
// Faults are injectable at runtime (no restart) and resettable independently.
// The expected fault label is intentionally NOT exposed through diagnosis
// evidence endpoints; only observed behavior is.

export type FaultKind = "bad-deployment" | "broken-config" | "failing-dependency" | "none";

type FaultState = {
  kind: FaultKind;
  injectedAt: string | null;
};

let state: FaultState = { kind: "none", injectedAt: null };

export function getFault(): FaultState {
  return { ...state };
}

export function injectFault(kind: FaultKind): FaultState {
  state = { kind, injectedAt: new Date().toISOString() };
  return getFault();
}

export function resetFault(): FaultState {
  state = { kind: "none", injectedAt: null };
  return getFault();
}
