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
    if (!id || !cli) {
      console.error("MISSING_ENV", JSON.stringify({ id, cli }));
      process.exit(1);
    }
    // 使用 Bun.spawn + process.execPath 避免深层嵌套子进程中 \$ 的潜在问题
    const proc = Bun.spawn([process.execPath, "run", cli, "-t", id, "-s", "fake pi done"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      console.error("WRITEBACK_FAILED", stderr);
      process.exit(1);
    }
  `);

  // 使用空格分隔的多词命令（supervisor 会 split 并展开为数组）
  Bun.env.VKANBAN_PI_CMD = `bun run ${fakePiPath}`;
});

afterAll(async () => {
  closeDb();
  delete Bun.env.VKANBAN_PI_CMD;
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

describe("e2e — full dispatch flow with fake pi", () => {
  test("vkanban -p → daemon --once → pi → writeback done", async () => {
    // 通过真实的 vkanban -p 派发任务
    const dispatchOutput = await $`bun run ${CLI} -p full_test "full flow test"`.text();
    const dispatchResult = JSON.parse(dispatchOutput.trim().split("\n").pop()!);
    expect(dispatchResult.task_id).toBeTruthy();
    const tid = dispatchResult.task_id;

    expect(getTaskById(tid)!.status).toBe("pending");

    // 用 daemon --once 执行单一任务
    const daemonOutput = await $`bun run ${CLI} daemon --once`.text();
    expect(daemonOutput).toContain("task_claimed");
    expect(daemonOutput).toContain("task_finished");

    const finalTask = getTaskById(tid);
    expect(finalTask).toBeTruthy();
    expect(finalTask!.status).toBe("done");
    expect(finalTask!.output).toContain("fake pi done");
  }, 30000);
});
