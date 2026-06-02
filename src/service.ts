export type ServiceAction = "install" | "uninstall" | "start" | "stop" | "status";

export interface ServiceCommandOptions {
  serviceName: string;
  cliPath?: string;
  bunPath?: string;
  vkHome?: string;
  piCmd?: string;
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
    if (!options.cliPath || !options.bunPath || !options.vkHome) {
      throw new Error("cliPath, bunPath and vkHome are required for service install");
    }
    const setHome = `set "VKANBAN_HOME=${options.vkHome}"`;
    const setPi = options.piCmd ? `set "VKANBAN_PI_CMD=${options.piCmd}"` : "";
    const envVars = [setHome, setPi].filter(Boolean).join(" && ");
    const bunCmd = `\"${options.bunPath}\" run \"${options.cliPath}\" daemon`;
    const tr = envVars ? `cmd /c ${envVars} && ${bunCmd}` : bunCmd;
    const args: string[] = ["/create", "/tn", taskName, "/tr", tr, "/sc", "onstart", "/ru", "SYSTEM", "/rl", "HIGHEST", "/f"];
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
