import type { Command } from "commander";
import * as path from "node:path";
import { registerProject } from "../registry";

export function register(program: Command): void {
  program
    .command("init <name> [dir]")
    .description("Register a project directory under a name")
    .action((name: string, dir?: string) => {
      try {
        const cwd = dir ? path.resolve(dir) : process.cwd();
        const entry = registerProject(name, cwd);
        console.log(JSON.stringify({ status: "ok", project: entry }));
      } catch (e: any) {
        console.error(JSON.stringify({ status: "error", message: e.message }));
        process.exit(1);
      }
    });
}
