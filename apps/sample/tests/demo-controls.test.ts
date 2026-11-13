import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  getFaultMode,
  getFaultState,
  isControlPinnedByEnv,
  resetFaultMode,
  setFaultMode
} from "../src/lib/faults";
import { GET as getFaults, POST as postFaults } from "../src/app/api/demo/faults/route";
import { POST as dryRunPost } from "../src/app/api/demo/dry-run/route";
import { GET as getTasks, POST as postTasks } from "../src/app/api/tasks/route";
import { PATCH as patchTask, DELETE as deleteTask } from "../src/app/api/tasks/[id]/route";
import {
  classifyProbe,
  evaluatePolicy,
  type ProbeResult
} from "../src/lib/policy";
import { GET as getHealth } from "../src/app/api/health/route";
import { tasks } from "../src/lib/tasks";

const originalFaultMode = process.env.DEMO_FAULT_MODE;
const originalEnabled = process.env.DEMO_CONTROLS_ENABLED;
const originalToken = process.env.DEMO_CONTROL_TOKEN;

function setEnv(mode: string | undefined) {
  if (mode === undefined) {
    delete process.env.DEMO_FAULT_MODE;
  } else {
    process.env.DEMO_FAULT_MODE = mode;
  }
}

function enableControls() {
  process.env.DEMO_CONTROLS_ENABLED = "true";
  process.env.DEMO_CONTROL_TOKEN = "test-token";
}

function disableControls() {
  delete process.env.DEMO_CONTROLS_ENABLED;
  delete process.env.DEMO_CONTROL_TOKEN;
}

function authedRequest(body?: unknown, host = "localhost:3000"): Request {
  return new Request("http://localhost:3000/api/demo/faults", {
    method: body === undefined ? "GET" : "POST",
    headers: {
      host,
      Authorization: "Bearer test-token",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

beforeEach(() => {
  setEnv(undefined);
  enableControls();
});

afterEach(() => {
  setEnv(originalFaultMode);
  if (originalEnabled === undefined) delete process.env.DEMO_CONTROLS_ENABLED;
  else process.env.DEMO_CONTROLS_ENABLED = originalEnabled;
  if (originalToken === undefined) delete process.env.DEMO_CONTROL_TOKEN;
  else process.env.DEMO_CONTROL_TOKEN = originalToken;
  if (!originalFaultMode) {
    resetFaultMode();
  }
});

describe("fault controls", () => {
  test("set fault via control API affects the real API routes", async () => {
    const response = await postFaults(authedRequest({ action: "set", mode: "runtime" }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.state.mode).toBe("runtime");
    expect(body.state.source).toBe("control");
    expect(getFaultMode()).toBe("runtime");

    const [health, taskList] = await Promise.all([
      getHealth(),
      getTasks(new Request("http://localhost/api/tasks"))
    ]);
    expect(health.status).toBe(500);
    expect(taskList.status).toBe(500);
  });

  test("reset restores healthy behavior", async () => {
    await postFaults(authedRequest({ action: "set", mode: "persistent" }));
    expect(getFaultMode()).toBe("persistent");

    const response = await postFaults(authedRequest({ action: "reset" }));
    expect(response.status).toBe(200);
    expect(getFaultMode()).toBe("healthy");

    const [health, taskList] = await Promise.all([
      getHealth(),
      getTasks(new Request("http://localhost/api/tasks"))
    ]);
    expect(health.status).toBe(200);
    expect(taskList.status).toBe(200);
  });

  test("dependency mode returns 503 on tasks while health and summary stay healthy", async () => {
    setFaultMode("dependency");

    const [health, taskList] = await Promise.all([
      getHealth(),
      getTasks(new Request("http://localhost/api/tasks"))
    ]);
    expect(health.status).toBe(200);
    expect(taskList.status).toBe(503);
    const body = await taskList.json();
    expect(body.ok).toBe(false);
    expect(body.mode).toBe("dependency");
  });

  test("ambiguous mode fails health and tasks but not summary", async () => {
    setFaultMode("ambiguous");

    const [health, taskList] = await Promise.all([
      getHealth(),
      getTasks(new Request("http://localhost/api/tasks"))
    ]);
    expect(health.status).toBe(500);
    expect(taskList.status).toBe(500);
  });

  test("invalid mode is rejected with 400 and does not change state", async () => {
    const response = await postFaults(authedRequest({ action: "set", mode: "explode" }));
    expect(response.status).toBe(400);
    expect(getFaultMode()).toBe("healthy");
  });

  test("malformed or non-object JSON bodies are rejected with 400", async () => {
    const badJson = await postFaults(
      new Request("http://localhost:3000/api/demo/faults", {
        method: "POST",
        headers: { host: "localhost:3000", Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: "{not json"
      })
    );
    expect(badJson.status).toBe(400);

    const arrayBody = await postFaults(
      new Request("http://localhost:3000/api/demo/faults", {
        method: "POST",
        headers: { host: "localhost:3000", Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: "[1,2]"
      })
    );
    expect(arrayBody.status).toBe(400);
    expect(getFaultMode()).toBe("healthy");
  });

  test("environment-pinned fault disables controls", async () => {
    setEnv("runtime");
    expect(isControlPinnedByEnv()).toBe(true);

    const setResponse = await postFaults(authedRequest({ action: "set", mode: "healthy" }));
    expect(setResponse.status).toBe(409);
    const resetResponse = await postFaults(authedRequest({ action: "reset" }));
    expect(resetResponse.status).toBe(409);
    expect(getFaultMode()).toBe("runtime");

    const stateResponse = await getFaults();
    const stateBody = await stateResponse.json();
    expect(stateBody.pinnedByEnv).toBe(true);
    expect(stateBody.state.source).toBe("env");
  });
});

describe("demo control security boundary", () => {
  test("controls are disabled by default and reject mutations", async () => {
    disableControls();
    const response = await postFaults(authedRequest({ action: "set", mode: "runtime" }));
    expect(response.status).toBe(403);
    expect(getFaultMode()).toBe("healthy");
  });

  test("a spoofed loopback Host header alone cannot authorize a mutation", async () => {
    const spoofed = new Request("http://evil.example.com/api/demo/faults", {
      method: "POST",
      headers: { host: "localhost:3000", "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set", mode: "runtime" })
    });
    const response = await postFaults(spoofed);
    expect(response.status).toBe(401);
    expect(getFaultMode()).toBe("healthy");
  });

  test("a valid token from a non-loopback host is rejected", async () => {
    const remote = new Request("http://192.168.1.10:3000/api/demo/faults", {
      method: "POST",
      headers: { host: "192.168.1.10:3000", Authorization: "Bearer test-token", "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set", mode: "runtime" })
    });
    const response = await postFaults(remote);
    expect(response.status).toBe(401);
    expect(getFaultMode()).toBe("healthy");
  });

  test("a wrong token is rejected even on loopback", async () => {
    const wrong = new Request("http://localhost:3000/api/demo/faults", {
      method: "POST",
      headers: { host: "localhost:3000", Authorization: "Bearer wrong", "Content-Type": "application/json" },
      body: JSON.stringify({ action: "reset" })
    });
    const response = await postFaults(wrong);
    expect(response.status).toBe(401);
  });
});

describe("task CRUD endpoints", () => {
  test("POST creates a task, PATCH updates it, DELETE removes it", async () => {
    const before = tasks.length;

    const created = await postTasks(
      new Request("http://localhost/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Write tests", description: "CRUD", status: "Todo" })
      })
    );
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody.ok).toBe(true);
    const id = createdBody.task.id as number;
    expect(tasks.length).toBe(before + 1);

    const patched = await patchTask(
      new Request(`http://localhost/api/tasks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "Done" })
      }),
      { params: Promise.resolve({ id: String(id) }) }
    );
    expect(patched.status).toBe(200);
    const patchedBody = await patched.json();
    expect(patchedBody.task.status).toBe("Done");

    const list = await getTasks(new Request("http://localhost/api/tasks"));
    const listBody = await list.json();
    expect(listBody.tasks.some((t: { id: number }) => t.id === id)).toBe(true);

    const deleted = await deleteTask(
      new Request(`http://localhost/api/tasks/${id}`, { method: "DELETE" }),
      { params: Promise.resolve({ id: String(id) }) }
    );
    expect(deleted.status).toBe(200);
    expect(tasks.length).toBe(before);

    const missing = await deleteTask(
      new Request("http://localhost/api/tasks/999999", { method: "DELETE" }),
      { params: Promise.resolve({ id: "999999" }) }
    );
    expect(missing.status).toBe(404);
  });

  test("POST rejects missing title and malformed JSON with 400", async () => {
    const noTitle = await postTasks(
      new Request("http://localhost/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: "no title" })
      })
    );
    expect(noTitle.status).toBe(400);

    const badJson = await postTasks(
      new Request("http://localhost/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json"
      })
    );
    expect(badJson.status).toBe(400);
  });

  test("mutations fail with 503 under dependency fault and 500 under runtime fault", async () => {
    setFaultMode("dependency");
    const dep = await postTasks(
      new Request("http://localhost/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "x" })
      })
    );
    expect(dep.status).toBe(503);

    setFaultMode("runtime");
    const runtime = await patchTask(
      new Request("http://localhost/api/tasks/1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "Done" })
      }),
      { params: Promise.resolve({ id: "1" }) }
    );
    expect(runtime.status).toBe(500);
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

  test("dry-run endpoint requires the control token and reports target unchanged", async () => {
    disableControls();
    const disabled = await dryRunPost(
      new Request("http://localhost:3000/api/demo/dry-run", {
        method: "POST",
        headers: { host: "localhost:3000" }
      })
    );
    expect(disabled.status).toBe(403);

    enableControls();
    const before = getFaultState().mode;
    const response = await dryRunPost(
      new Request("http://localhost:3000/api/demo/dry-run", {
        method: "POST",
        headers: { host: "localhost:3000", Authorization: "Bearer test-token" }
      })
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.report.dryRun).toBe(true);
    expect(body.report.outcome.targetChanged).toBe(false);
    expect(getFaultState().mode).toBe(before);
  });
});
