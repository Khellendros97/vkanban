import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { $ } from "bun";
import { nanoid } from "nanoid";
import { initDb, closeDb } from "../../src/db";
import { initRegistry, registerProject } from "../../src/registry";
import { insertTask, casPendingToRunning, casRunningToDone, getTaskById } from "../../src/tasks";

const E2E_HOME = path.join(require("node:os").tmpdir(), "vkanban_e2e_" + Date.now());
const CLI = path.resolve("src/cli.ts");

beforeAll(() => {
  fs.mkdirSync(E2E_HOME, { recursive: true });
  Bun.env.VKANBAN_HOME = E2E_HOME;
  initRegistry();
  initDb();
  const projDir = path.join(E2E_HOME, "proj_a");
  fs.mkdirSync(projDir, { recursive: true });
  registerProject("my_app", projDir);
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

describe("e2e — init", () => {
  test("vkanban init registers a project", async () => {
    const projDir = path.join(E2E_HOME, "proj_b");
    fs.mkdirSync(projDir, { recursive: true });
    const result = await $`bun run ${CLI} init proj_b ${projDir}`.json();
    expect(result.status).toBe("ok");
  });

  test("duplicate name fails", async () => {
    const result = await $`bun run ${CLI} init proj_b ${E2E_HOME} 2>&1`.nothrow().text();
    expect(result).toContain("already registered");
  });
});

describe("e2e — query (-t)", () => {
  test("-t queries a task by id", async () => {
    const id = nanoid(12);
    insertTask({ id, project_name: "my_app", project_path: path.join(E2E_HOME, "proj_a"), content: "test" });
    const result = await $`bun run ${CLI} -t ${id}`.json();
    expect(result.id).toBe(id);
    expect(result.status).toBe("pending");
  });

  test("-t with invalid id fails", async () => {
    const result = await $`bun run ${CLI} -t nonexistent123 2>&1`.nothrow().text();
    expect(result).toContain("not found");
  });
});

describe("e2e — writeback (-t -s)", () => {
  test("-t -s sets output on running task", async () => {
    const id = nanoid(12);
    insertTask({ id, project_name: "my_app", project_path: path.join(E2E_HOME, "proj_a"), content: "x" });
    casPendingToRunning(id);
    const result = await $`bun run ${CLI} -t ${id} -s "done output"`.json();
    expect(result.new_status).toBe("done");
  });

  test("-t -s on done task fails", async () => {
    const id = nanoid(12);
    insertTask({ id, project_name: "my_app", project_path: path.join(E2E_HOME, "proj_a"), content: "x" });
    casPendingToRunning(id);
    casRunningToDone(id, "x");
    const out = await $`bun run ${CLI} -t ${id} -s "more" 2>&1`.nothrow().text();
    expect(out).toContain("terminal");
  });
});

describe("e2e — fail (-t --fail)", () => {
  test("-t --fail transitions to failed", async () => {
    const id = nanoid(12);
    insertTask({ id, project_name: "my_app", project_path: path.join(E2E_HOME, "proj_a"), content: "x" });
    casPendingToRunning(id);
    const result = await $`bun run ${CLI} -t ${id} --fail "broken"`.json();
    expect(result.new_status).toBe("failed");
    const task = getTaskById(id);
    expect(task!.error_code).toBe("pi_failed");
  });
});

describe("e2e — list (ls)", () => {
  test("ls lists projects", async () => {
    const result = await $`bun run ${CLI} ls`.text();
    expect(result).toContain("my_app");
  });

  test("ls <name> lists tasks", async () => {
    const result = await $`bun run ${CLI} ls my_app`.text();
    expect(result).toContain("ID");
  });
});

describe("e2e — cancel (-t --cancel)", () => {
  test("-t --cancel transitions to cancelled", async () => {
    const id = nanoid(12);
    insertTask({ id, project_name: "my_app", project_path: path.join(E2E_HOME, "proj_a"), content: "test" });
    casPendingToRunning(id);
    const result = await $`bun run ${CLI} -t ${id} --cancel`.json();
    expect(result.new_status).toBe("cancelled");
    const task = getTaskById(id);
    expect(task!.status).toBe("cancelled");
    expect(task!.error_code).toBe("cancelled");
  });
});

describe("e2e — dispatch (-p)", () => {
  test("-p enqueues a pending task and returns task_id", async () => {
    const result = await $`bun run ${CLI} -p my_app "e2e dispatch test"`.json();
    expect(result.task_id).toBeTruthy();
    const task = getTaskById(result.task_id);
    expect(task!.project_name).toBe("my_app");
    expect(task!.content).toBe("e2e dispatch test");
    expect(task!.status).toBe("pending");
    expect(task!.claimed_at).toBeNull();
    expect(task!.started_at).toBeNull();
  });
});

describe("e2e — wait (-t -v)", () => {
  test("-t -v blocks until done", async () => {
    const id = nanoid(12);
    insertTask({ id, project_name: "my_app", project_path: path.join(E2E_HOME, "proj_a"), content: "wait" });
    casPendingToRunning(id);
    setTimeout(() => { casRunningToDone(id, "quick"); }, 200);
    const result = await $`bun run ${CLI} -t ${id} -v`.json();
    expect(result.status).toBe("done");
  }, 10000);
});
