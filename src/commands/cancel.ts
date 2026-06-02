import type { Command } from "commander";
import { casPendingToCancelled, casRunningToCancelled, getTaskById } from "../tasks";

export function register(program: Command): void {
  program
    .command("cancel")
    .description("Cancel a pending or running task")
    .requiredOption("-t, --task <id>", "Task ID")
    .action((opts: { task: string }) => {
      const task = getTaskById(opts.task);
      if (!task) {
        console.error(JSON.stringify({ status: "error", message: "Task not found" }));
        process.exit(1);
      }
      if (task.status !== "pending" && task.status !== "running") {
        console.error(JSON.stringify({
          status: "error",
          message: `Task cannot be cancelled (current: ${task.status})`,
        }));
        process.exit(2);
      }
      const result = task.status === "pending"
        ? casPendingToCancelled(opts.task)
        : casRunningToCancelled(opts.task);
      if (result.changed) {
        console.log(JSON.stringify({ status: "ok", task_id: opts.task, new_status: "cancelled" }));
      } else {
        console.error(JSON.stringify({ status: "error", message: "Cancel failed (race detected)" }));
        process.exit(2);
      }
    });
}
