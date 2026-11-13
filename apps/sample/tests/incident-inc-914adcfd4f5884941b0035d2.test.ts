import { expect, test } from "bun:test";
import { GET as getMissingTask } from "../src/app/api/tasks/crash/route";

test("reading a missing task returns a successful response instead of crashing", async () => {
  const response = await getMissingTask();

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, status: "Todo" });
});
