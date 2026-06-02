import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { nanoid } from "nanoid";
import { initDb, closeDb } from "../../src/db";
import { initRegistry, registerProject } from "../../src/registry";
import { insertTask, getTaskById } from "../../src/tasks";
import { runWorkerOnce } from "../../src/worker";

const E2E_HOME = path.join(require("node:os").tmpdir(), "vkanban_e2e_sup_" + Date.now());

beforeAll(() => {
  fs.mkdirSync(E2E_HOME, { recursive: true });
  Bun.env.VKANBAN_HOME = E2E_HOME;
  initRegistry();
  registerProject("proj_sup", E2E_HOME);
  initDb();
  Bun.env.VKANBAN_CLI_OVERRIDE = path.resolve("src/cli.ts");
});

afterAll(async () => {
  closeDb();
  delete Bun.env.VKANBAN_PI_CMD;
  delete Bun.env.VKANBAN_CLI_OVERRIDE;
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

describe("e2e — daemon pi crash兜底", () => {
  test("worker兜底: pi 启动失败 → spawn_failed", async () => {
    const id = nanoid(12);
    insertTask({ id, project_name: "proj_sup", project_path: E2E_HOME, content: "test" });
    Bun.env.VKANBAN_PI_CMD = "nonexistent_pi_command_xyz";

    const result = await runWorkerOnce();
    const task = getTaskById(id);

    expect(result.status).toBe("processed");
    expect(task!.status).toBe("failed");
    expect(task!.error_code).toBe("spawn_failed");
  }, 15000);
});
