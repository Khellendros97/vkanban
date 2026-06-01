// src/kill.ts
import treeKill from "tree-kill";

/**
 * 杀掉指定进程及其所有子进程。
 * 跨平台封装，内部使用 tree-kill（Linux/macOS: 进程组信号; Windows: taskkill /T）。
 * v0 保留此封装以便未来 cancel-with-kill 场景使用。
 */
export function killProcessTree(pid: number, signal: string = "SIGTERM"): Promise<void> {
  return new Promise((resolve) => {
    treeKill(pid, signal, () => resolve());
  });
}
