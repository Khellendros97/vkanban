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
  executable: "sc.exe";
  args: string[];
}

export function buildServiceCommand(action: ServiceAction, options: ServiceCommandOptions): BuiltServiceCommand {
  const serviceName = options.serviceName;
  if (action === "install") {
    if (!options.cliPath || !options.bunPath) {
      throw new Error("cliPath and bunPath are required for service install");
    }
    const displayName = options.displayName || "vkanban daemon";
    const startType = options.startType || "auto";
    const binPath = `"${options.bunPath}" run "${options.cliPath}" daemon`;
    return {
      executable: "sc.exe",
      args: [
        "create",
        serviceName,
        "binPath=",
        binPath,
        "DisplayName=",
        displayName,
        "start=",
        startType,
      ],
    };
  }

  const commandByAction: Record<Exclude<ServiceAction, "install">, string> = {
    uninstall: "delete",
    start: "start",
    stop: "stop",
    status: "query",
  };

  return { executable: "sc.exe", args: [commandByAction[action], serviceName] };
}

export async function executeServiceCommand(command: BuiltServiceCommand): Promise<{ exitCode: number; stdout: string; stderr: string }> {
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
