import { afterEach, describe, expect, test } from "bun:test";
import { GET as getFaults, POST as inject, DELETE as reset } from "../src/app/api/faults/route";
import { GET as getTasks } from "../src/app/api/tasks/route";
import { getFault, resetFault } from "../src/lib/faults";

function postReq(kind: string) {
  return new Request("http://localhost/api/faults", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind })
  });
}

afterEach(() => {
  resetFault();
  delete process.env.DEMO_FAULT_MODE;
});

describe("fault injection and reset", () => {
  test("starts with no fault and records injection time", async () => {
    const res = await inject(postReq("bad-deployment"));
    const body = await res.json();
    expect(body.kind).toBe("bad-deployment");
    expect(typeof body.injectedAt).toBe("string");
  });

  test("bad-deployment fault makes tasks endpoint fail", async () => {
    await inject(postReq("bad-deployment"));
    const res = await getTasks();
    expect(res.status).toBe(500);
  });

  test("broken-config fault makes tasks endpoint fail", async () => {
    await inject(postReq("broken-config"));
    const res = await getTasks();
    expect(res.status).toBe(500);
  });

  test("failing-dependency fault makes tasks endpoint report dependency error", async () => {
    await inject(postReq("failing-dependency"));
    const res = await getTasks();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.dependency).toBe("down");
  });

  test("reset restores known-good state", async () => {
    await inject(postReq("bad-deployment"));
    const res = await reset();
    const body = await res.json();
    expect(body.kind).toBe("none");
    expect(body.injectedAt).toBeNull();
  });

  test("invalid fault kind is rejected", async () => {
    const res = await inject(postReq("unsafe-thing"));
    expect(res.status).toBe(400);
  });

  test("GET returns current fault state", async () => {
    await inject(postReq("failing-dependency"));
    const res = await getFaults();
    const body = await res.json();
    expect(body.kind).toBe("failing-dependency");
    expect(getFault().kind).toBe("failing-dependency");
  });
});
