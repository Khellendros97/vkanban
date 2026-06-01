import type { Command } from "commander";
import { listProjects } from "../registry";
import { listTasksByProject } from "../tasks";

export function register(program: Command): void {
  program
    .command("list")
    .alias("ls")
    .description("List projects or tasks")
    .argument("[name]", "Project name (optional)")
    .option("--json", "Output JSON")
    .action((name?: string, opts?: { json?: boolean }) => {
      if (name) {
        const tasks = listTasksByProject(name, 50);
        if (opts?.json) {
          console.log(JSON.stringify(tasks));
        } else {
          if (tasks.length === 0) {
            console.log("No tasks found.");
            return;
          }
          console.log("ID                    STATUS    CREATED              OUTPUT");
          for (const t of tasks) {
            const id = t.id.padEnd(22);
            const status = t.status.padEnd(10);
            const created = new Date(t.created_at).toISOString().replace("T", " ").substring(0, 19);
            const out = (t.output || "").substring(0, 40);
            console.log(`${id}${status}${created}  ${out}`);
          }
        }
      } else {
        const projects = listProjects();
        if (opts?.json) {
          console.log(JSON.stringify(projects));
        } else {
          if (projects.length === 0) {
            console.log("No registered projects.");
            return;
          }
          console.log("NAME                   PATH                                    REGISTERED          TASKS");
          for (const p of projects) {
            const pname = p.name.padEnd(22);
            const ppath = p.path.padEnd(40);
            const reg = new Date(p.registered_at).toISOString().replace("T", " ").substring(0, 19);
            const taskCount = listTasksByProject(p.name, 10000).length;
            console.log(`${pname}${ppath}${reg}  ${taskCount}`);
          }
        }
      }
    });
}
