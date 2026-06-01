import type { Command } from "commander";
import { nanoid } from "nanoid";
import * as path from "node:path";
import { getProject } from "../registry";
import { insertTask, casPendingToRunning, casRunningToFailed, getTaskById } from "../tasks";
import { resolveSupervisorEntrypoint, resolveCliPath, resolveVkanbanHome } from "../paths";

const CLAIM_TIMEOUT_MS = Number(process.env.VKANBAN_CLAIM_TIMEOUT_MS || 5000);

export function register(program: Command): void {
  program
    .command("dispatch")
    .description("Dispatch a task to a project")
    .requiredOption("-p, --project <name>", "Target project name")
    .argument("<content...>", "Task content")
    .action(async (contentArgs: string[], opts: { project: string }) => {
      const project = getProject(opts.project);
      if (!project) {
        console.error(JSON.stringify({ status: "error", message: `Project "${opts.project}" not registered.` }));
        process.exit(1);
      }

      const content = contentArgs.join(" ");
      if (content.length > 28 * 1024) {
        console.error(JSON.stringify({ status: "error", message: "Content exceeds 28 KiB limit." }));
        process.exit(1);
      }

      const id = nanoid(12);

      insertTask({ id, project_name: project.name, project_path: project.path, content });

      const casResult = casPendingToRunning(id);
      if (!casResult.changed) {
        console.error(JSON.stringify({ status: "error", message: "Failed to transition task to running" }));
        process.exit(2);
      }

      const supervisorEntry = resolveSupervisorEntrypoint();
      const cliPath = resolveCliPath();
      const homePath = resolveVkanbanHome();
      const dbPath = path.join(homePath, "data.db");

      let proc;
      try {
        proc = Bun.spawn([process.execPath, "run", supervisorEntry], {
          cwd: project.path,
          env: {
            ...process.env,
            VKANBAN_TASK_ID: id,
            VKANBAN_CLI: cliPath,
            VKANBAN_HOME: homePath,
            VKANBAN_DB: dbPath,
            VKANBAN_PROJECT_PATH: project.path,
          },
          detached: process.platform !== "win32",
          windowsHide: true,
          stdio: ["ignore", "ignore", "ignore"],
        });
        proc.unref();
      } catch (e) {
        casRunningToFailed(id, "spawn_failed", String(e));
        console.log(JSON.stringify({ task_id: id }));
        console.error(JSON.stringify({ status: "error", message: "Failed to spawn supervisor" }));
        process.exit(3);
      }

      // 5s claim 监控
      const pollInterval = 500;
      const startTime = Date.now();
      let claimed = false;

      while (Date.now() - startTime < CLAIM_TIMEOUT_MS) {
        await new Promise((r) => setTimeout(r, pollInterval));
        const task = getTaskById(id);
        if (task?.claimed_at) {
          claimed = true;
          break;
        }
        if (task?.status !== "running") {
          break;
        }
      }

      if (!claimed) {
        casRunningToFailed(id, "supervisor_not_claimed", "Supervisor did not claim within timeout");
        // 始终先输出 task_id，然后 warning
        console.log(JSON.stringify({ task_id: id }));
        console.error(JSON.stringify({
          status: "warning",
          message: "Supervisor did not claim within timeout; marked as failed.",
        }));
        process.exit(0);
      }

      console.log(JSON.stringify({ task_id: id }));
    });
}
