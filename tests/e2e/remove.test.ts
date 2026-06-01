import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { $ } from "bun";
import { nanoid } from "nanoid";
import { initDb, closeDb, getDb } from "../../src/db";
import { initRegistry, registerProject } from "../../src/registry";
import { insertTask, casPendingToRunning } from "../../src/tasks";

const E2E_HOME = path.join(require("node:os").tmpdir(), "vkanban_e2e_rem_" + Date.now());
const CLI = path.resolve("src/cli.ts");

beforeAll(() => {
  fs.mkdirSync(E2E_HOME, { recursive: true });
  Bun.env.VKANBAN_HOME = E2E_HOME;
  initRegistry();
  initDb();
});

afterAll(() => {
  closeDb();
  fs.rmSync(E2E_HOME, { recursive: true, force: true });
});

describe("e2e — remove", () => {
  test("remove with running tasks fails without --cancel-running", async () => {
    const proj = path.join(E2E_HOME, "rm_test");
    fs.mkdirSync(proj, { recursive: true });
    registerProject("rm_test", proj);
    const id = nanoid(12);
    insertTask({ id, project_name: "rm_test", project_path: proj, content: "x" });
    casPendingToRunning(id);
    const result = await $`bun run ${CLI} remove rm_test --purge 2>&1`.nothrow().text();
    expect(result).toContain("running");
  });

  test("remove --purge --cancel-running succeeds", async () => {
    const result = await $`bun run ${CLI} remove rm_test --purge --cancel-running`.json();
    expect(result.status).toBe("ok");
    const db = getDb();
    const count = db.query("SELECT COUNT(*) as cnt FROM tasks WHERE project_name = ?").get("rm_test") as { cnt: number };
    expect(count.cnt).toBe(0);
  });
});
