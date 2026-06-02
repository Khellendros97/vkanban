import * as path from "node:path";
import { which } from "bun";
import { casRunningToFailed, claimNextPendingTask, getTaskById } from "./tasks";
import { resolveCliPath, resolveVkanbanHome } from "./paths";

export interface WorkerRunResult {
  status: "idle" | "processed";
  task_id?: string;
}

export interface DaemonOptions {
  pollIntervalMs: number;
  once?: boolean;
}

function splitCommand(raw: string): string[] {
  return raw.split(/\s+/).filter(Boolean);
}

function jsonStdout(value: unknown): void {
  console.log(JSON.stringify(value));
}

function jsonStderr(value: unknown): void {
  console.error(JSON.stringify(value));
}

export async function runWorkerOnce(): Promise<WorkerRunResult> {
  const task = claimNextPendingTask();
  if (!task) return { status: "idle" };

  jsonStdout({ event: "task_claimed", task_id: task.id });

  const rawPiCmd = Bun.env.VKANBAN_PI_CMD || "pi";
  const piCmdParts = splitCommand(which(rawPiCmd) || rawPiCmd);
  const cliPath = resolveCliPath();
  const homePath = resolveVkanbanHome();
  const dbPath = path.join(homePath, "data.db");
  const isDebug = Bun.env.VKANBAN_DEBUG === "1";
  const prompt = "execute your kanban task";
  const piArgs = isDebug
    ? [...piCmdParts, "--vkanban", task.id, prompt]
    : [...piCmdParts, "--vkanban", task.id, "-p", prompt];

  let piProc;
  try {
    piProc = Bun.spawn(piArgs, {
      cwd: task.project_path,
      env: {
        ...Bun.env,
        VKANBAN_TASK_ID: task.id,
        VKANBAN_CLI: cliPath,
        VKANBAN_HOME: homePath,
        VKANBAN_DB: dbPath,
        VKANBAN_PROJECT_PATH: task.project_path,
      },
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch (error) {
    casRunningToFailed(task.id, "spawn_failed", String(error));
    jsonStderr({ event: "task_failed", task_id: task.id, error_code: "spawn_failed", message: String(error) });
    return { status: "processed", task_id: task.id };
  }

  const exitCode = await piProc.exited;
  const current = getTaskById(task.id);
  if (current?.status === "running") {
    const message = `pi exited (code=${exitCode}) without writing back. Use: vkanban -t ${task.id} -s "<output>" or --fail "<reason>"`;
    casRunningToFailed(task.id, "pi_exited_no_callback", message);
  }

  const finalTask = getTaskById(task.id);
  jsonStdout({ event: "task_finished", task_id: task.id, status: finalTask?.status ?? "unknown" });
  return { status: "processed", task_id: task.id };
}

export async function runDaemon(options: DaemonOptions): Promise<void> {
  jsonStdout({ event: "daemon_started", poll_interval_ms: options.pollIntervalMs, once: options.once === true });
  while (true) {
    const result = await runWorkerOnce();
    if (options.once) return;
    if (result.status === "idle") {
      await new Promise((resolve) => setTimeout(resolve, options.pollIntervalMs));
    }
  }
}
