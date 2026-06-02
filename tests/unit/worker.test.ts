import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { initDb, closeDb } from "../../src/db";
import { initRegistry, registerProject } from "../../src/registry";
import { insertTask, getTaskById } from "../../src/tasks";
import { runWorkerOnce } from "../../src/worker";

let testHome: string;
let cliPath: string;

beforeEach(() => {
  testHome = path.join(os.tmpdir(), "vkanban_worker_test_" + Date.now() + "_" + Math.random().toString(16).slice(2));
  fs.mkdirSync(testHome, { recursive: true });
  Bun.env.VKANBAN_HOME = testHome;
  initRegistry();
  initDb();
  registerProject("worker_project", testHome);
  cliPath = path.resolve("src/cli.ts");
  Bun.env.VKANBAN_CLI_OVERRIDE = cliPath;
});

afterEach(() => {
  closeDb();
  delete Bun.env.VKANBAN_PI_CMD;
  delete Bun.env.VKANBAN_CLI_OVERRIDE;
  fs.rmSync(testHome, { recursive: true, force: true });
});

describe("worker", () => {
  test("runWorkerOnce returns idle when no pending task exists", async () => {
    const result = await runWorkerOnce();
    expect(result.status).toBe("idle");
  });

  test("runWorkerOnce executes fake pi and preserves writeback", async () => {
    const fakePiPath = path.join(testHome, "fake_pi.ts");
    fs.writeFileSync(fakePiPath, `
      const id = Bun.env.VKANBAN_TASK_ID;
      const cli = Bun.env.VKANBAN_CLI;
      const proc = Bun.spawn([process.execPath, "run", cli!, "-t", id!, "-s", "worker done"], {
        stdio: ["ignore", "ignore", "ignore"],
      });
      process.exit(await proc.exited);
    `);
    Bun.env.VKANBAN_PI_CMD = `bun run ${fakePiPath}`;
    const task = insertTask({ id: "worker_done", project_name: "worker_project", project_path: testHome, content: "run" });

    const result = await runWorkerOnce();
    const stored = getTaskById(task.id)!;

    expect(result.status).toBe("processed");
    expect(result.task_id).toBe(task.id);
    expect(stored.status).toBe("done");
    expect(stored.output).toBe("worker done");
  }, 15000);

  test("runWorkerOnce marks spawn failure", async () => {
    Bun.env.VKANBAN_PI_CMD = "nonexistent_pi_command_xyz";
    const task = insertTask({ id: "worker_spawn", project_name: "worker_project", project_path: testHome, content: "run" });

    const result = await runWorkerOnce();
    const stored = getTaskById(task.id)!;

    expect(result.status).toBe("processed");
    expect(stored.status).toBe("failed");
    expect(stored.error_code).toBe("spawn_failed");
  }, 15000);

  test("runWorkerOnce marks pi_exited_no_callback when pi exits without writeback", async () => {
    // fake pi: 成功 exit 但不调用 writeback
    const fakePiPath = path.join(testHome, "fake_pi_exit.ts");
    fs.writeFileSync(fakePiPath, "process.exit(0);\n");
    Bun.env.VKANBAN_PI_CMD = `bun run ${fakePiPath}`;
    const task = insertTask({ id: "worker_nocb", project_name: "worker_project", project_path: testHome, content: "run" });

    const result = await runWorkerOnce();
    const stored = getTaskById(task.id)!;

    expect(result.status).toBe("processed");
    expect(stored.status).toBe("failed");
    expect(stored.error_code).toBe("pi_exited_no_callback");
  }, 15000);
});
