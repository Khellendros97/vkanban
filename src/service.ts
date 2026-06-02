export type ServiceAction = "install" | "uninstall" | "start" | "stop" | "status";
export type ServiceStartType = "auto" | "demand";

export interface ServiceCommandOptions {
  serviceName: string;
  displayName?: string;
  startType?: ServiceStartType;
  cliPath?: string;
  bunPath?: string;
}

export interface BuiltServiceCommand {
  executable: "schtasks.exe";
  args: string[];
}

export function buildServiceCommand(
  action: ServiceAction,
  options: ServiceCommandOptions,
): BuiltServiceCommand {
  const taskName = options.serviceName;

  if (action === "install") {
    if (!options.cliPath || !options.bunPath) {
      throw new Error("cliPath and bunPath are required for service install");
    }
    const startType = options.startType || "auto";
    const tr = `\"${options.bunPath}\" run \"${options.cliPath}\" daemon`;
    const args: string[] = ["/create", "/tn", taskName, "/tr", tr, "/ru", "SYSTEM", "/rl", "HIGHEST", "/f"];
    if (startType === "auto") {
      args.push("/sc", "onstart");
    } else {
      // demand: 不设置自动触发器，仅允许手动启动
      args.push("/sc", "onstart");
      args.push("/delay", "0001:00"); // 延迟 1 小时启动，effectively disabled auto
    }
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
