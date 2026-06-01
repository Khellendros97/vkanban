import type { Command } from "commander";
import { getTaskById } from "../tasks";

export function register(program: Command): void {
  program
    .command("query")
    .description("Query task by id")
    .requiredOption("-t, --task <id>", "Task ID")
    .option("-o, --output", "Print output only (done→raw output, failed→[error]+reason, else status)")
    .action((opts: { task: string; output?: boolean }) => {
      const task = getTaskById(opts.task);
      if (!task) {
        console.error(JSON.stringify({ status: "error", message: `Task "${opts.task}" not found` }));
        process.exit(1);
      }
      if (opts.output) {
        if (task.status === "done") {
          process.stdout.write(task.output);
        } else if (task.status === "failed") {
          console.error("[error] " + (task.error_code || ""));
          if (task.output) console.error(task.output);
        } else if (task.status === "cancelled") {
          console.log("cancelled");
        } else {
          console.log(task.status);
        }
      } else {
        console.log(JSON.stringify(task));
      }
    });
}
