import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { $ } from "bun";
import { nanoid } from "nanoid";
import { initDb, closeDb } from "../../src/db";
import { initRegistry, registerProject } from "../../src/registry";
import { insertTask, casPendingToRunning, getTaskById } from "../../src/tasks";

const E2E_HOME = path.join(require("node:os").tmpdir(), "vkanban_e2e_cancel_" + Date.now());
const CLI = path.resolve("src/cli.ts");

beforeAll(() => {
  fs.mkdirSync(E2E_HOME, { recursive: true });
  Bun.env.VKANBAN_HOME = E2E_HOME;
  initRegistry();
  registerProject("my_app", E2E_HOME);
  initDb();
});

afterAll(() => {
  closeDb();
  fs.rmSync(E2E_HOME, { recursive: true, force: true });
});

describe("e2e — cancel", () => {
  test("--cancel transitions running→cancelled", async () => {
    const id = nanoid(12);
    insertTask({ id, project_name: "my_app", project_path: E2E_HOME, content: "test" });
    casPendingToRunning(id);
    const result = await $`bun run ${CLI} cancel -t ${id}`.json();
    expect(result.new_status).toBe("cancelled");
    expect(getTaskById(id)!.error_code).toBe("cancelled");
  });

  test("--cancel on done task fails with exit 2", async () => {
    const id = nanoid(12);
    insertTask({ id, project_name: "my_app", project_path: E2E_HOME, content: "test" });
    casPendingToRunning(id);
    const { casRunningToDone } = await import("../../src/tasks");
    casRunningToDone(id, "x");
    const result = await $`bun run ${CLI} cancel -t ${id}`.nothrow();
    expect(result.stderr?.toString()).toContain("not running");
  });
});
