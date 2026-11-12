import { afterEach, describe, expect, test } from "bun:test";
import { GET as getHealth } from "../src/app/api/health/route";
import { GET as getTasks } from "../src/app/api/tasks/route";
import { GET as getSummary } from "../src/app/api/tasks/summary/route";

const originalFaultMode = process.env.DEMO_FAULT_MODE;

function setFaultMode(mode: string | undefined) {
  if (mode === undefined) {
    delete process.env.DEMO_FAULT_MODE;
  } else {
    process.env.DEMO_FAULT_MODE = mode;
  }
}

afterEach(() => {
  setFaultMode(originalFaultMode);
});

describe("API fault scenarios", () => {
  test("defaults to healthy responses and returns task summary counts", async () => {
    setFaultMode(undefined);

    const [health, taskList, summary] = await Promise.all([
      getHealth(),
      getTasks(),
      getSummary()
    ]);
    const taskBody = await taskList.json();
    const summaryBody = await summary.json();

    expect(health.status).toBe(200);
    expect(taskList.status).toBe(200);
    expect(taskBody.ok).toBe(true);
    expect(taskBody.count).toBe(4);
    expect(summary.status).toBe(200);
    expect(summaryBody.summary).toEqual({
      total: 4,
      todo: 2,
      inProgress: 1,
      done: 1
    });
  });

  test("runtime mode fails health and tasks but not summary", async () => {
    setFaultMode("runtime");

    const [health, taskList, summary] = await Promise.all([
      getHealth(),
      getTasks(),
      getSummary()
    ]);

    expect(health.status).toBe(500);
    expect(taskList.status).toBe(500);
    expect(summary.status).toBe(200);
  });

  test("persistent mode fails tasks while health and summary remain healthy", async () => {
    setFaultMode("persistent");

    const [health, taskList, summary] = await Promise.all([
      getHealth(),
      getTasks(),
      getSummary()
    ]);

    expect(health.status).toBe(200);
    expect(taskList.status).toBe(500);
    expect(summary.status).toBe(200);
  });
});
