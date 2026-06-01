import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { nanoid } from "nanoid";
import { initDb, closeDb } from "../../src/db";
import { initRegistry, registerProject } from "../../src/registry";
import { insertTask, casPendingToRunning, getTaskById } from "../../src/tasks";
import { resolveSupervisorEntrypoint } from "../../src/paths";

const E2E_HOME = path.join(require("node:os").tmpdir(), "vkanban_e2e_full_" + Date.now());
const CLI = path.resolve("src/cli.ts");
const SUPERVISOR_ENTRY = resolveSupervisorEntrypoint();

beforeAll(() => {
  fs.mkdirSync(E2E_HOME, { recursive: true });
  Bun.env.VKANBAN_HOME = E2E_HOME;
  initRegistry();
  registerProject("full_test", E2E_HOME);
  initDb();
});

afterAll(() => {
  closeDb();
  fs.rmSync(E2E_HOME, { recursive: true, force: true });
});

describe("e2e — full dispatch flow with fake pi", () => {
  test("dispatch → supervisor → pi callback → done", async () => {
    // 创建 fake pi .ts 脚本（通过 env var 获取 task_id 并写回）
    const fakePiTs = path.join(E2E_HOME, "fake_pi.ts");
    fs.writeFileSync(fakePiTs, `
const id = process.env.VKANBAN_TASK_ID;
const cli = process.env.VKANBAN_CLI;
const { $ } = await import("bun");
await $\`bun run \${cli} -t \${id} -s "fake pi done"\`;
`);

    // Windows 上 Bun.spawn 无法直接执行 .ts，创建 .bat 包装器
    const fakePiBat = path.join(E2E_HOME, "fake_pi.bat");
    fs.writeFileSync(fakePiBat, `@echo off\r\nbun run "${fakePiTs}"\r\n`);

    // 直接插入 task 并设为 running（模拟 dispatch 完成后的状态）
    const id = nanoid(12);
    insertTask({ id, project_name: "full_test", project_path: E2E_HOME, content: "full flow test" });
    casPendingToRunning(id);

    // spawn supervisor（类似 picrash.test.ts 的方式）
    const supProc = Bun.spawn(["bun", "run", SUPERVISOR_ENTRY], {
      cwd: E2E_HOME,
      env: {
        ...process.env,
        VKANBAN_TASK_ID: id,
        VKANBAN_CLI: CLI,
        VKANBAN_HOME: E2E_HOME,
        VKANBAN_DB: path.join(E2E_HOME, "data.db"),
        VKANBAN_PROJECT_PATH: E2E_HOME,
        VKANBAN_PI_CMD: fakePiBat,
      },
      stdout: "ignore",
      stderr: "ignore",
    });

    // 等待 supervisor 退出
    const exitCode = await supProc.exited;

    // 验证 task 终态
    const finalTask = getTaskById(id);
    expect(finalTask!.status).toBe("done");
    expect(finalTask!.output).toContain("fake pi done");

    delete Bun.env.VKANBAN_PI_CMD;
  }, 15000);
});
