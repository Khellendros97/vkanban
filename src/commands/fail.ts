import type { Command } from "commander";
import { casRunningToFailed, getTaskById } from "../tasks";

export function register(program: Command): void {
  program
    .command("fail")
    .description("Mark task as failed (pi callback)")
    .requiredOption("-t, --task <id>", "Task ID")
    .requiredOption("-r, --reason <reason>", "Failure reason")
    .action((opts: { task: string; reason: string }) => {
      const task = getTaskById(opts.task);
      if (!task) {
        console.error(JSON.stringify({ status: "error", message: "Task not found" }));
        process.exit(1);
      }
      if (opts.reason.length > 1024 * 1024) {
        console.error(JSON.stringify({ status: "error", message: "Reason exceeds 1 MiB limit" }));
        process.exit(1);
      }
      if (task.status !== "running") {
        console.error(JSON.stringify({
          status: "error",
          message: `Task is already in terminal state: ${task.status}`,
        }));
        process.exit(2);
      }
      const result = casRunningToFailed(opts.task, "pi_failed", opts.reason);
      if (result.changed) {
        console.log(JSON.stringify({ status: "ok", task_id: opts.task, new_status: "failed" }));
      } else {
        console.error(JSON.stringify({ status: "error", message: "Status transition failed (race detected)" }));
        process.exit(2);
      }
    });
}
