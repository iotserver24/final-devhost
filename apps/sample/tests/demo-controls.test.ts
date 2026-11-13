import { afterEach, describe, expect, test } from "bun:test";
import {
  getFaultMode,
  getFaultState,
  isControlPinnedByEnv,
  resetFaultMode,
  setFaultMode
} from "../src/lib/faults";
import { GET as getFaults, POST as postFaults } from "../src/app/api/demo/faults/route";
import { POST as dryRunPost } from "../src/app/api/demo/dry-run/route";
import {
  classifyProbe,
  evaluatePolicy,
  type ProbeResult
} from "../src/lib/policy";
import { GET as getHealth } from "../src/app/api/health/route";
import { GET as getTasks } from "../src/app/api/tasks/route";

const originalFaultMode = process.env.DEMO_FAULT_MODE;

function setEnv(mode: string | undefined) {
  if (mode === undefined) {
    delete process.env.DEMO_FAULT_MODE;
  } else {
    process.env.DEMO_FAULT_MODE = mode;
  }
}

function demoRequest(body?: unknown, host = "localhost:3000"): Request {
  return new Request("http://localhost:3000/api/demo/faults", {
    method: body === undefined ? "GET" : "POST",
    headers: { host, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

afterEach(() => {
  setEnv(originalFaultMode);
  if (!originalFaultMode) {
    // Return the in-memory control state to healthy after each test.
    resetFaultMode();
  }
});

describe("fault controls", () => {
  test("set fault via control API affects the real API routes", async () => {
    setEnv(undefined);

    const response = await postFaults(demoRequest({ action: "set", mode: "runtime" }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.state.mode).toBe("runtime");
    expect(body.state.source).toBe("control");
    expect(getFaultMode()).toBe("runtime");

    const [health, taskList] = await Promise.all([getHealth(), getTasks(new Request("http://localhost/api/tasks"))]);
    expect(health.status).toBe(500);
    expect(taskList.status).toBe(500);
  });

  test("reset restores healthy behavior", async () => {
    setEnv(undefined);
    await postFaults(demoRequest({ action: "set", mode: "persistent" }));
    expect(getFaultMode()).toBe("persistent");

    const response = await postFaults(demoRequest({ action: "reset" }));
    expect(response.status).toBe(200);
    expect(getFaultMode()).toBe("healthy");

    const [health, taskList] = await Promise.all([getHealth(), getTasks(new Request("http://localhost/api/tasks"))]);
    expect(health.status).toBe(200);
    expect(taskList.status).toBe(200);
  });

  test("dependency mode returns 503 on tasks while health and summary stay healthy", async () => {
    setEnv(undefined);
    setFaultMode("dependency");

    const [health, taskList] = await Promise.all([getHealth(), getTasks(new Request("http://localhost/api/tasks"))]);
    expect(health.status).toBe(200);
    expect(taskList.status).toBe(503);
    const body = await taskList.json();
    expect(body.ok).toBe(false);
    expect(body.mode).toBe("dependency");
  });

  test("ambiguous mode fails health and tasks but not summary", async () => {
    setEnv(undefined);
    setFaultMode("ambiguous");

    const [health, taskList] = await Promise.all([getHealth(), getTasks(new Request("http://localhost/api/tasks"))]);
    expect(health.status).toBe(500);
    expect(taskList.status).toBe(500);
  });

  test("invalid mode is rejected with 400 and does not change state", async () => {
    setEnv(undefined);
    const response = await postFaults(demoRequest({ action: "set", mode: "explode" }));
    expect(response.status).toBe(400);
    expect(getFaultMode()).toBe("healthy");
  });

  test("environment-pinned fault disables controls", async () => {
    setEnv("runtime");
    expect(isControlPinnedByEnv()).toBe(true);

    const setResponse = await postFaults(demoRequest({ action: "set", mode: "healthy" }));
    expect(setResponse.status).toBe(409);
    const resetResponse = await postFaults(demoRequest({ action: "reset" }));
    expect(resetResponse.status).toBe(409);
    expect(getFaultMode()).toBe("runtime");

    const stateResponse = await getFaults(demoRequest(undefined));
    const stateBody = await stateResponse.json();
    expect(stateBody.pinnedByEnv).toBe(true);
    expect(stateBody.state.source).toBe("env");
  });

  test("controls are restricted to demo (loopback) hosts", async () => {
    setEnv(undefined);
    const response = await postFaults(
      demoRequest({ action: "set", mode: "runtime" }, "example.com:3000")
    );
    expect(response.status).toBe(403);
    expect(getFaultMode()).toBe("healthy");

    const getResponse = await getFaults(demoRequest(undefined, "10.0.0.5:3000"));
    expect(getResponse.status).toBe(403);
  });
});

describe("unreachable service classification", () => {
  test("a null status is classified as unreachable, not failing", () => {
    const probe = classifyProbe("tasks", null, "fetch failed");
    expect(probe.reachable).toBe(false);
    expect(probe.healthy).toBe(false);
    expect(probe.status).toBeNull();
    expect(probe.error).toBe("fetch failed");
  });

  test("non-2xx reachable responses are failing, not unreachable", () => {
    const probe = classifyProbe("health", 500, null);
    expect(probe.reachable).toBe(true);
    expect(probe.healthy).toBe(false);
  });
});

describe("dry-run policy", () => {
  test("policy blocks when any service is unhealthy or unreachable", () => {
    const probes: ProbeResult[] = [
      classifyProbe("health", 500, null),
      classifyProbe("tasks", null, "connection refused"),
      classifyProbe("summary", 200, null)
    ];
    const outcome = evaluatePolicy(probes);
    expect(outcome.allowed).toBe(false);
    expect(outcome.targetChanged).toBe(false);
    expect(outcome.reason).toContain("unreachable");
  });

  test("policy allows when all services are healthy and never changes the target", () => {
    const probes: ProbeResult[] = [
      classifyProbe("health", 200, null),
      classifyProbe("tasks", 200, null),
      classifyProbe("summary", 200, null)
    ];
    const outcome = evaluatePolicy(probes);
    expect(outcome.allowed).toBe(true);
    expect(outcome.targetChanged).toBe(false);
  });

  test("dry-run endpoint is demo-restricted and reports target unchanged", async () => {
    setEnv(undefined);
    const forbidden = await dryRunPost(
      new Request("http://example.com/api/demo/dry-run", {
        method: "POST",
        headers: { host: "example.com" }
      })
    );
    expect(forbidden.status).toBe(403);

    const before = getFaultState().mode;
    const response = await dryRunPost(
      new Request("http://localhost:3000/api/demo/dry-run", {
        method: "POST",
        headers: { host: "localhost:3000" }
      })
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.report.dryRun).toBe(true);
    expect(body.report.outcome.targetChanged).toBe(false);
    expect(getFaultState().mode).toBe(before);
  });
});
