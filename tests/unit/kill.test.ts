// tests/unit/kill.test.ts
import { describe, test, expect } from "bun:test";
import { killProcessTree } from "../../src/kill";
import { spawn } from "node:child_process";

describe("killProcessTree", () => {
  test("kills a spawned child process without error", async () => {
    const platformCmd = process.platform === "win32"
      ? ["cmd", ["/c", "timeout /t 10"]]
      : ["sleep", ["10"]];
    const [bin, args] = platformCmd;
    const child = spawn(bin, args, { detached: true, stdio: "ignore" });

    await killProcessTree(child.pid!, "SIGTERM");

    // 等待进程终止
    await new Promise((r) => setTimeout(r, 500));
    try {
      process.kill(child.pid!, 0);
      // 若没抛错，进程仍在 → 手动清理
      child.kill("SIGKILL");
      throw new Error("Process not killed");
    } catch (e: any) {
      if (e.message === "Process not killed") throw e;
      // 期望抛错（进程不存在）
    }
  }, 15000);
});
