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

afterAll(async () => {
  closeDb();
  // 给子进程时间释放句柄，然后重试删除
  await new Promise(r => setTimeout(r, 1000));
  for (let i = 0; i < 5; i++) {
    try {
      fs.rmSync(E2E_HOME, { recursive: true, force: true });
      break;
    } catch {
      await new Promise(r => setTimeout(r, 500));
    }
  }
});

describe("e2e — cancel", () => {
  test("-t --cancel transitions to cancelled", async () => {
    const id = nanoid(12);
    insertTask({ id, project_name: "my_app", project_path: E2E_HOME, content: "test" });
    casPendingToRunning(id);
    const result = await $`bun run ${CLI} -t ${id} --cancel`.json();
    expect(result.new_status).toBe("cancelled");
    expect(getTaskById(id)!.status).toBe("cancelled");
  });

  test("-t --cancel on done task fails", async () => {
    const id = nanoid(12);
    insertTask({ id, project_name: "my_app", project_path: E2E_HOME, content: "test" });
    casPendingToRunning(id);
    const { casRunningToDone } = await import("../../src/tasks");
    casRunningToDone(id, "x");
    const out = await $`bun run ${CLI} -t ${id} --cancel 2>&1`.nothrow().text();
    expect(out).toContain("not running");
  });
});
