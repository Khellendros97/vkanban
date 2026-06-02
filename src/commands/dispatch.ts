import type { Command } from "commander";
import { nanoid } from "nanoid";
import { getProject } from "../registry";
import { insertTask } from "../tasks";

export function register(program: Command): void {
  program
    .command("dispatch")
    .description("Dispatch a task to a project")
    .requiredOption("-p, --project <name>", "Target project name")
    .option("-d, --debug", "Debug mode: pi interactive mode with prompt (no -p flag)")
    .argument("<content...>", "Task content")
    .action((contentArgs: string[], opts: { project: string; debug?: boolean }) => {
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
      console.log(JSON.stringify({ task_id: id }));
    });
}
