// src/paths.ts
import * as path from "node:path";
import * as os from "node:os";

/**
 * 解析 VKANBAN_HOME 目录，默认 ~/.vkanban。
 * 优先使用 VKANBAN_HOME 环境变量。
 */
export function resolveVkanbanHome(): string {
  if (Bun.env.VKANBAN_HOME) {
    return path.resolve(Bun.env.VKANBAN_HOME);
  }
  return path.join(os.homedir(), ".vkanban");
}

/**
 * 解析 supervisor 子进程入口文件路径。
 * 优先：VKANBAN_SUPERVISOR_OVERRIDE 环境变量（开发/测试用）
 * 默认：与 paths.ts 同目录的 supervisor.ts
 */
export function resolveSupervisorEntrypoint(): string {
  if (Bun.env.VKANBAN_SUPERVISOR_OVERRIDE) {
    return path.resolve(Bun.env.VKANBAN_SUPERVISOR_OVERRIDE);
  }
  // 与当前模块同目录的 supervisor.ts（Bun 原生支持 ts 加载）
  return path.join(import.meta.dir, "supervisor.ts");
}

/**
 * 解析 vkanban CLI 可执行文件绝对路径。
 * 优先：VKANBAN_CLI_OVERRIDE 环境变量
 * 默认：process.argv[1]（当前主入口）
 *
 * **仅限 vkanban 父进程（cli.ts）内调用。**
 * supervisor 子进程必须透传父进程注入的 process.env.VKANBAN_CLI。
 */
export function resolveCliPath(): string {
  if (Bun.env.VKANBAN_CLI_OVERRIDE) {
    return path.resolve(Bun.env.VKANBAN_CLI_OVERRIDE);
  }
  return process.argv[1];
}
