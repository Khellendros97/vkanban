import type { Command } from "commander";
import { getTaskById } from "../tasks";

const WAIT_TIMEOUT_MS = Number(process.env.VKANBAN_WAIT_TIMEOUT_MS || 30 * 60 * 1000);
const POLL_INTERVAL = 500;

export function register(program: Command): void {
  program
    .command("wait")
    .description("Block until task reaches terminal state")
    .requiredOption("-t, --task <id>", "Task ID")
    .action(async (opts: { task: string }) => {
      const task = getTaskById(opts.task);
      if (!task) {
        console.error(JSON.stringify({ status: "error", message: "Task not found" }));
        process.exit(1);
      }

      const startTime = Date.now();

      while (true) {
        const current = getTaskById(opts.task);
        if (!current) {
          console.error(JSON.stringify({ status: "error", message: "Task vanished" }));
          process.exit(1);
        }

        if (["done", "failed", "cancelled"].includes(current.status)) {
          console.log(JSON.stringify(current));
          process.exit(current.status === "done" ? 0 : 1);
        }

        if (Date.now() - startTime > WAIT_TIMEOUT_MS) {
          console.error(JSON.stringify({ status: "timeout", message: "Wait timed out", task_id: opts.task }));
          process.exit(124);
        }

        await new Promise((r) => setTimeout(r, POLL_INTERVAL));
      }
    });
}
