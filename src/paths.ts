import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";

export function resolveVkanbanHome(): string {
  if (Bun.env.VKANBAN_HOME) {
    return path.resolve(Bun.env.VKANBAN_HOME);
  }
  return path.join(os.homedir(), ".vkanban");
}

export function resolveSupervisorEntrypoint(): string {
  if (Bun.env.VKANBAN_SUPERVISOR_OVERRIDE) {
    const raw = Bun.env.VKANBAN_SUPERVISOR_OVERRIDE;
    if (!path.isAbsolute(raw)) {
      throw new Error("VKANBAN_SUPERVISOR_OVERRIDE must be an absolute path");
    }
    return path.resolve(raw);
  }
  // 与当前模块同目录：优先 .ts（开发态），否则 .js（发布态）
  const dir = import.meta.dir;
  const tsPath = path.join(dir, "supervisor.ts");
  const jsPath = path.join(dir, "supervisor.js");
  if (fs.existsSync(tsPath)) return tsPath;
  if (fs.existsSync(jsPath)) return jsPath;
  throw new Error(`Supervisor entry not found at ${tsPath} or ${jsPath}`);
}

export function resolveCliPath(): string {
  if (Bun.env.VKANBAN_CLI_OVERRIDE) {
    const raw = Bun.env.VKANBAN_CLI_OVERRIDE;
    if (!path.isAbsolute(raw)) {
      throw new Error("VKANBAN_CLI_OVERRIDE must be an absolute path");
    }
    return path.resolve(raw);
  }
  // process.argv[1] 在 Bun 中已是绝对路径，但显式 resolve 保底
  return path.resolve(process.argv[1]);
}
