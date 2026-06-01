import type { Command } from "commander";
import { casRunningToDone, getTaskById } from "../tasks";

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

export function register(program: Command): void {
  program
    .command("writeback")
    .description("Write back task output (pi callback). Use -s for inline, or pipe from stdin.")
    .requiredOption("-t, --task <id>", "Task ID")
    .option("-s, --set-output <output>", "Output content (use '-' or omit to read from stdin)")
    .action(async (opts: { task: string; setOutput?: string }) => {
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

      // 决定 output 来源：优先 -s 参数，如果 -s "-" 或未提供则读 stdin
      let output: string;
      if (opts.setOutput && opts.setOutput !== "-") {
        output = opts.setOutput;
      } else {
        output = await readStdin();
      }

      if (output.length > 1024 * 1024) {
        console.error(JSON.stringify({ status: "error", message: "Output exceeds 1 MiB limit" }));
        process.exit(1);
      }

      const result = casRunningToDone(opts.task, output);
      if (result.changed) {
        console.log(JSON.stringify({ status: "ok", task_id: opts.task, new_status: "done" }));
      } else {
        console.error(JSON.stringify({ status: "error", message: "Status transition failed (race detected)" }));
        process.exit(2);
      }
    });
}
