import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { nanoid } from "nanoid";
import { initDb, closeDb } from "../../src/db";
import { initRegistry, registerProject } from "../../src/registry";
import { insertTask, casPendingToRunning, getTaskById } from "../../src/tasks";
import { resolveSupervisorEntrypoint } from "../../src/paths";

const E2E_HOME = path.join(require("node:os").tmpdir(), "vkanban_e2e_sup_" + Date.now());
const SUPERVISOR_ENTRY = resolveSupervisorEntrypoint();

beforeAll(() => {
  fs.mkdirSync(E2E_HOME, { recursive: true });
  Bun.env.VKANBAN_HOME = E2E_HOME;
  initRegistry();
  registerProject("proj_sup", E2E_HOME);
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

describe("e2e — supervisor pi crash兜底", () => {
  test("supervisor兜底: pi 退出未写回 → pi_exited_no_callback", async () => {
    const id = nanoid(12);
    insertTask({ id, project_name: "proj_sup", project_path: E2E_HOME, content: "test" });
    casPendingToRunning(id);

    const supProc = Bun.spawn(["bun", "run", SUPERVISOR_ENTRY], {
      cwd: E2E_HOME,
      env: {
        ...process.env,
        VKANBAN_TASK_ID: id,
        VKANBAN_CLI: process.argv[1],
        VKANBAN_HOME: E2E_HOME,
        VKANBAN_DB: path.join(E2E_HOME, "data.db"),
        VKANBAN_PROJECT_PATH: E2E_HOME,
        VKANBAN_PI_CMD: "nonexistent_pi_command_xyz",
      },
      stdout: "ignore",
      stderr: "ignore",
    });

    const exitCode = await supProc.exited;
    const task = getTaskById(id);
    expect(task!.status).toBe("failed");
    expect(["spawn_failed", "pi_exited_no_callback"]).toContain(task!.error_code);
  }, 15000);
});
