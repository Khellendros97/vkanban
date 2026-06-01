import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { $ } from "bun";
import { initDb, closeDb } from "../../src/db";
import { initRegistry, registerProject } from "../../src/registry";
import { getTaskById } from "../../src/tasks";

const E2E_HOME = path.join(require("node:os").tmpdir(), "vkanban_e2e_full_" + Date.now());
const CLI = path.resolve("src/cli.ts");

beforeAll(() => {
  fs.mkdirSync(E2E_HOME, { recursive: true });
  Bun.env.VKANBAN_HOME = E2E_HOME;
  initRegistry();
  registerProject("full_test", E2E_HOME);
  initDb();

  // 创建 fake pi 脚本
  const fakePiPath = path.join(E2E_HOME, "fake_pi.ts");
  fs.writeFileSync(fakePiPath, `
    const id = process.env.VKANBAN_TASK_ID;
    const cli = process.env.VKANBAN_CLI;
    const { $ } = await import("bun");
    await $\`bun run \${cli} -t \${id} -s "fake pi done"\`;
  `);

  // Windows 上 Bun.spawn 无法直接将 "bun run <file>.ts" 识别为可执行文件，
  // 创建 .bat 包装器（对非 Windows 平台也安全，cmd /c 兼容）
  const fakePiBat = path.join(E2E_HOME, "fake_pi.bat");
  fs.writeFileSync(fakePiBat, `@echo off\r\nbun run "${fakePiPath}" %*\r\n`);

  Bun.env.VKANBAN_PI_CMD = fakePiBat;
});

afterAll(() => {
  closeDb();
  delete Bun.env.VKANBAN_PI_CMD;
  fs.rmSync(E2E_HOME, { recursive: true, force: true });
});

describe("e2e — full dispatch flow with fake pi", () => {
  test("vkanban -p → supervisor → pi → writeback done (full chain)", async () => {
    // 通过真实的 vkanban -p 派发任务
    const dispatchOutput = await $`bun run ${CLI} -p full_test "full flow test"`.text();
    const dispatchResult = JSON.parse(dispatchOutput.trim().split("\n").pop()!);
    expect(dispatchResult.task_id).toBeTruthy();
    const tid = dispatchResult.task_id;

    // 等待 supervisor + fake pi 完成（最多 20s）
    let finalTask;
    for (let attempt = 0; attempt < 40; attempt++) {
      finalTask = getTaskById(tid);
      if (finalTask && finalTask.status !== "running" && finalTask.status !== "pending") break;
      await new Promise(r => setTimeout(r, 500));
    }

    expect(finalTask).toBeTruthy();
    expect(finalTask!.status).toBe("done");
    expect(finalTask!.output).toContain("fake pi done");
  }, 30000);
});
