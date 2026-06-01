import type { Command } from "commander";
import { casRunningToFailed, getTaskById } from "../tasks";

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

export function register(program: Command): void {
  program
    .command("fail")
    .description("Mark task as failed (pi callback). Use -r for inline, or pipe from stdin.")
    .requiredOption("-t, --task <id>", "Task ID")
    .option("-r, --reason <reason>", "Failure reason (use '-' or omit to read from stdin)")
    .action(async (opts: { task: string; reason?: string }) => {
      const task = getTaskById(opts.task);
      if (!task) {
        console.error(JSON.stringify({ status: "error", message: "Task not found" }));
        process.exit(1);
      }
      if (task.status !== "running") {
        console.error(JSON.stringify({
          status: "error",
          message: `Task is already in terminal state: ${task.status}`,
        }));
        process.exit(2);
      }

      let reason: string;
      if (opts.reason && opts.reason !== "-") {
        reason = opts.reason;
      } else {
        reason = await readStdin();
      }

      if (reason.length > 1024 * 1024) {
        console.error(JSON.stringify({ status: "error", message: "Reason exceeds 1 MiB limit" }));
        process.exit(1);
      }

      const result = casRunningToFailed(opts.task, "pi_failed", reason);
      if (result.changed) {
        console.log(JSON.stringify({ status: "ok", task_id: opts.task, new_status: "failed" }));
      } else {
        console.error(JSON.stringify({ status: "error", message: "Status transition failed (race detected)" }));
        process.exit(2);
      }
    });
}
