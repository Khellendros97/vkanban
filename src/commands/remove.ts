import type { Command } from "commander";
import { removeProject, getProject } from "../registry";
import { getDb } from "../db";
import { casRunningToCancelled, listTasksByProject } from "../tasks";

export function register(program: Command): void {
  program
    .command("remove <name>")
    .description("Unregister a project (optionally purge tasks)")
    .option("--purge", "Delete all tasks for this project")
    .option("--cancel-running", "Cancel running tasks before purge (required with --purge)")
    .action((name: string, opts: { purge?: boolean; cancelRunning?: boolean }) => {
      const db = getDb();

      if (opts.purge) {
        const running = listTasksByProject(name, 10000).filter((t: any) => t.status === "running");
        if (running.length > 0) {
          if (!opts.cancelRunning) {
            console.error(JSON.stringify({
              status: "error",
              message: `${running.length} running task(s) exist. Use --cancel-running to cancel them.`,
            }));
            process.exit(2);
          }
          for (const task of running) {
            casRunningToCancelled(task.id);
          }
        }
      }

      try {
        const entry = removeProject(name);
        console.log(JSON.stringify({ status: "ok", project: entry.name, removed_at: entry.removed_at }));
      } catch (e: any) {
        console.error(JSON.stringify({ status: "error", message: e.message }));
        process.exit(1);
      }

      if (opts.purge) {
        const count = db.query("SELECT COUNT(*) as cnt FROM tasks WHERE project_name = ?").get(name) as { cnt: number };
        db.query("DELETE FROM tasks WHERE project_name = ?").run(name);
        console.error(JSON.stringify({ status: "info", tasks_deleted: count.cnt }));
      }
    });
}
