import type { Command } from "commander";
import { which } from "bun";
import { resolveCliPath } from "../paths";
import { buildServiceCommand, executeServiceCommand, type ServiceAction, type ServiceStartType } from "../service";

const DEFAULT_SERVICE_NAME = "vkanban-daemon";

function ensureWindows(): void {
  if (process.platform !== "win32") {
    console.error(JSON.stringify({ status: "error", message: "service command is only supported on Windows" }));
    process.exit(1);
  }
}

async function runServiceAction(action: ServiceAction, opts: { name?: string; start?: ServiceStartType }): Promise<void> {
  ensureWindows();
  const serviceName = opts.name || DEFAULT_SERVICE_NAME;
  const bunPath = which("bun") || process.execPath;
  const command = buildServiceCommand(action, {
    serviceName,
    displayName: opts.displayName,
    startType: opts.start,
    cliPath: resolveCliPath(),
    bunPath,
  });
  const result = await executeServiceCommand(command);
  const payload = { status: result.exitCode === 0 ? "ok" : "error", action, service_name: serviceName, stdout: result.stdout, stderr: result.stderr };
  if (result.exitCode === 0) {
    console.log(JSON.stringify(payload));
  } else {
    console.error(JSON.stringify(payload));
    process.exit(result.exitCode);
  }
}

export function register(program: Command): void {
  const service = program.command("service").description("Manage vkanban daemon via Windows Task Scheduler");

  service.command("install")
    .option("--name <name>", "Task name", DEFAULT_SERVICE_NAME)
    .option("--start <type>", "Start trigger: auto (on boot) or demand (manual only)", "auto")
    .action((opts: { name?: string; start?: ServiceStartType }) => runServiceAction("install", { name: opts.name, start: opts.start }));

  service.command("uninstall")
    .option("--name <name>", "Task name", DEFAULT_SERVICE_NAME)
    .action((opts: { name?: string }) => runServiceAction("uninstall", opts));

  service.command("start")
    .option("--name <name>", "Task name", DEFAULT_SERVICE_NAME)
    .action((opts: { name?: string }) => runServiceAction("start", opts));

  service.command("stop")
    .option("--name <name>", "Task name", DEFAULT_SERVICE_NAME)
    .action((opts: { name?: string }) => runServiceAction("stop", opts));

  service.command("status")
    .option("--name <name>", "Task name", DEFAULT_SERVICE_NAME)
    .action((opts: { name?: string }) => runServiceAction("status", opts));
}
