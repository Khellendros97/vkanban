import type { Command } from "commander";
import { runDaemon } from "../worker";

const DEFAULT_POLL_INTERVAL_MS = Number(Bun.env.VKANBAN_DAEMON_POLL_INTERVAL_MS || 1000);

function parsePollInterval(raw: string | undefined): number {
  if (!raw) return DEFAULT_POLL_INTERVAL_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("--poll-interval-ms must be a positive number");
  }
  return value;
}

export function register(program: Command): void {
  program
    .command("daemon")
    .description("Run the vkanban daemon worker")
    .option("--poll-interval-ms <ms>", "Polling interval when no pending task exists")
    .option("--once", "Process one available task, or exit if no task is pending")
    .action(async (opts: { pollIntervalMs?: string; once?: boolean }) => {
      try {
        await runDaemon({
          pollIntervalMs: parsePollInterval(opts.pollIntervalMs),
          once: opts.once === true,
        });
      } catch (error) {
        console.error(JSON.stringify({ status: "error", message: String(error) }));
        process.exit(1);
      }
    });
}
