import * as fs from "node:fs";
import * as path from "node:path";

export type ServiceAction = "install" | "uninstall" | "start" | "stop" | "status";

export interface ServiceCommandOptions {
  serviceName: string;
  cliPath?: string;
  bunPath?: string;
  vbsPath?: string;
}

export interface BuiltServiceCommand {
  executable: "schtasks.exe";
  args: string[];
}

/** 生成隐藏启动的 .vbs 文件，返回文件路径 */
export function writeVbsLauncher(vkHome: string, bunPath: string, cliPath: string): string {
  const vbsPath = path.join(vkHome, "daemon-launcher.vbs");
  // VBS 中双引号需写为 ""
  const bunQ = bunPath.replace(/"/g, "\"\"");
  const cliQ = cliPath.replace(/"/g, "\"\"");
  const content = `Set ws = CreateObject("WScript.Shell")\r\n`
    + `ws.Run """${bunQ}"" run ""${cliQ}"" daemon", 0, False\r\n`;
  fs.mkdirSync(vkHome, { recursive: true });
  fs.writeFileSync(vbsPath, content, "utf-8");
  return vbsPath;
}

export function buildServiceCommand(
  action: ServiceAction,
  options: ServiceCommandOptions,
): BuiltServiceCommand {
  const taskName = options.serviceName;

  if (action === "install") {
    if (!options.vbsPath) {
      throw new Error("vbsPath is required for service install");
    }
    const tr = `wscript.exe //B //Nologo \"${options.vbsPath}\"`;
    const args: string[] = ["/create", "/tn", taskName, "/tr", tr, "/sc", "onstart", "/rl", "HIGHEST", "/f"];
    return { executable: "schtasks.exe", args };
  }

  if (action === "uninstall") {
    return { executable: "schtasks.exe", args: ["/delete", "/tn", taskName, "/f"] };
  }

  if (action === "start") {
    return { executable: "schtasks.exe", args: ["/run", "/tn", taskName] };
  }

  if (action === "stop") {
    return { executable: "schtasks.exe", args: ["/end", "/tn", taskName] };
  }

  // status
  return { executable: "schtasks.exe", args: ["/query", "/tn", taskName, "/fo", "LIST"] };
}

export async function executeServiceCommand(
  command: BuiltServiceCommand,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([command.executable, ...command.args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}
