import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { $ } from "bun";
import { nanoid } from "nanoid";
import { initDb, closeDb, getDb } from "../../src/db";
import { initRegistry, registerProject } from "../../src/registry";
import { insertTask, casPendingToRunning, casRunningToDone, getTaskById } from "../../src/tasks";

const E2E_HOME = path.join(require("node:os").tmpdir(), "vkanban_e2e_" + Date.now());
const CLI = path.resolve("src/cli.ts");

beforeAll(() => {
  fs.mkdirSync(E2E_HOME, { recursive: true });
  Bun.env.VKANBAN_HOME = E2E_HOME;
  initRegistry();
  initDb();
  // register a test project
  const projDir = path.join(E2E_HOME, "proj_a");
  fs.mkdirSync(projDir, { recursive: true });
  registerProject("my_app", projDir);
});

afterAll(() => {
  closeDb();
  fs.rmSync(E2E_HOME, { recursive: true, force: true });
});

describe("e2e — init", () => {
  test("vkanban init registers a project", async () => {
    const projDir = path.join(E2E_HOME, "proj_b");
    fs.mkdirSync(projDir, { recursive: true });
    const result = await $`bun run ${CLI} init proj_b ${projDir}`.json();
    expect(result.status).toBe("ok");
  });

  test("duplicate name fails", async () => {
    const projDir = path.join(E2E_HOME, "proj_b2");
    fs.mkdirSync(projDir, { recursive: true });
    const result = await $`bun run ${CLI} init proj_b ${projDir}`.nothrow();
    expect(result.stderr?.toString()).toContain("already registered");
  });
});

describe("e2e — query", () => {
  test("-t queries a task by id", async () => {
    const id = nanoid(12);
    insertTask({ id, project_name: "my_app", project_path: path.join(E2E_HOME, "proj_a"), content: "test query" });
    const result = await $`bun run ${CLI} query -t ${id}`.json();
    expect(result.id).toBe(id);
    expect(result.status).toBe("pending");
  });

  test("-t with invalid id fails gracefully", async () => {
    const result = await $`bun run ${CLI} query -t nonexistent123`.nothrow();
    expect(result.stderr?.toString()).toContain("not found");
  });
});

describe("e2e — writeback", () => {
  test("-s sets output on running task", async () => {
    const id = nanoid(12);
    insertTask({ id, project_name: "my_app", project_path: path.join(E2E_HOME, "proj_a"), content: "x" });
    casPendingToRunning(id);
    const result = await $`bun run ${CLI} writeback -t ${id} -s "done output"`.json();
    expect(result.new_status).toBe("done");
  });

  test("-s on already done task fails", async () => {
    const id = nanoid(12);
    insertTask({ id, project_name: "my_app", project_path: path.join(E2E_HOME, "proj_a"), content: "x" });
    casPendingToRunning(id);
    casRunningToDone(id, "x");
    const result = await $`bun run ${CLI} writeback -t ${id} -s "more"`.nothrow();
    expect(result.stderr?.toString()).toContain("terminal");
  });
});

describe("e2e — fail", () => {
  test("--fail transitions running→failed with pi_failed error_code", async () => {
    const id = nanoid(12);
    insertTask({ id, project_name: "my_app", project_path: path.join(E2E_HOME, "proj_a"), content: "x" });
    casPendingToRunning(id);
    const result = await $`bun run ${CLI} fail -t ${id} -r "something broke"`.json();
    expect(result.new_status).toBe("failed");
    const task = getTaskById(id);
    expect(task!.error_code).toBe("pi_failed");
  });
});

describe("e2e — list", () => {
  test("ls lists all projects", async () => {
    const result = await $`bun run ${CLI} list`.text();
    expect(result).toContain("my_app");
  });

  test("ls <name> lists tasks for a project", async () => {
    const result = await $`bun run ${CLI} list my_app`.text();
    expect(result).toContain("ID");
  });

  test("ls <name> --json outputs JSON", async () => {
    const result = await $`bun run ${CLI} list my_app --json`.json();
    expect(Array.isArray(result)).toBe(true);
  });
});

describe("e2e — wait", () => {
  test("-v blocks until task is done", async () => {
    const id = nanoid(12);
    insertTask({ id, project_name: "my_app", project_path: path.join(E2E_HOME, "proj_a"), content: "wait test" });
    casPendingToRunning(id);
    // async set done after 200ms
    setTimeout(() => { casRunningToDone(id, "quick"); }, 200);
    const result = await $`bun run ${CLI} wait -t ${id}`.json();
    expect(result.status).toBe("done");
  }, 10000);
});
