import type { Command } from "commander";
import { getTaskById } from "../tasks";

export function register(program: Command): void {
  program
    .command("query")
    .description("Query task by id")
    .requiredOption("-t, --task <id>", "Task ID")
    .action((opts: { task: string }) => {
      const task = getTaskById(opts.task);
      if (!task) {
        console.error(JSON.stringify({ status: "error", message: `Task "${opts.task}" not found` }));
        process.exit(1);
      }
      console.log(JSON.stringify(task));
    });
}
