import type { Command } from "commander";
import { casRunningToDone, getTaskById } from "../tasks";

export function register(program: Command): void {
  program
    .command("writeback")
    .description("Write back task output (pi callback)")
    .requiredOption("-t, --task <id>", "Task ID")
    .requiredOption("-s, --set-output <output>", "Output content")
    .action((opts: { task: string; setOutput: string }) => {
      const task = getTaskById(opts.task);
      if (!task) {
        console.error(JSON.stringify({ status: "error", message: "Task not found" }));
        process.exit(1);
      }
      if (opts.setOutput.length > 1024 * 1024) {
        console.error(JSON.stringify({ status: "error", message: "Output exceeds 1 MiB limit" }));
        process.exit(1);
      }
      if (task.status !== "running") {
        console.error(JSON.stringify({
          status: "error",
          message: `Task is already in terminal state: ${task.status}`,
        }));
        process.exit(2);
      }
      const result = casRunningToDone(opts.task, opts.setOutput);
      if (result.changed) {
        console.log(JSON.stringify({ status: "ok", task_id: opts.task, new_status: "done" }));
      } else {
        console.error(JSON.stringify({ status: "error", message: "Status transition failed (race detected)" }));
        process.exit(2);
      }
    });
}
