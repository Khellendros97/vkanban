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

// 引号感知的命令行拆分（处理含空格路径如 "C:\Program Files\bun\bun.exe"）
function splitCommand(raw: string): string[] {
  const args: string[] = [];
  let current = "";
  let inQuote: string | null = null;
  for (const ch of raw) {
    if (inQuote) {
      if (ch === inQuote) { inQuote = null; continue; }
      current += ch;
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === " " || ch === "\t") {
      if (current) { args.push(current); current = ""; }
    } else {
      current += ch;
    }
  }
  if (current) args.push(current);
  return args;
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
  const parts = splitCommand(rawPiCmd);
  parts[0] = which(parts[0]) || parts[0];
  const piCmdParts = parts;
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
  const PROCESSED_COOLDOWN_MS = 10;
  while (true) {
    const result = await runWorkerOnce();
    if (options.once) return;
    // idle 时使用配置的轮询间隔；processed 时仅极短冷却避免紧循环
    const delay = result.status === "idle" ? options.pollIntervalMs : PROCESSED_COOLDOWN_MS;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}
