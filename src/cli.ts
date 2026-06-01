#!/usr/bin/env bun
import { Command } from "commander";
import { initDb } from "./db";
import { initRegistry } from "./registry";
import * as cmdInit from "./commands/init";
import * as cmdDispatch from "./commands/dispatch";
import * as cmdQuery from "./commands/query";
import * as cmdWriteback from "./commands/writeback";
import * as cmdFail from "./commands/fail";
import * as cmdCancel from "./commands/cancel";
import * as cmdWait from "./commands/wait";
import * as cmdList from "./commands/list";
import * as cmdRemove from "./commands/remove";

// -- 预处理层：将 spec 规定的顶层 flags 映射为内部子命令 --
function rewriteArgv(): void {
  const args = process.argv.slice(2);
  const rewritten: string[] = [];

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    if (arg === "-d" || arg === "--debug") {
      // -d 必须在 -p 之前；peek ahead 验证
      if (i + 1 < args.length && (args[i + 1] === "-p" || args[i + 1] === "--project")) {
        rewritten.push("dispatch", "-d", "-p", args[i + 2] || "");
        i += 3;
        while (i < args.length) {
          rewritten.push(args[i]);
          i++;
        }
        break;
      } else {
        rewritten.push(arg);
        i++;
      }
    } else if (arg === "-o") {
      // peek ahead: if -t follows, map to query -o
      if (i + 1 < args.length && (args[i + 1] === "-t" || args[i + 1] === "--task")) {
        rewritten.push("query", "-t", args[i + 2] || "", "-o");
        i += 3;
      } else {
        rewritten.push(arg);
        i++;
      }
    } else if (arg === "-p" || arg === "--project") {
      // -p <name> <content...> → dispatch -p <name> <content...>
      rewritten.push("dispatch", "-p", args[i + 1] || "");
      i += 2;
      // 剩余 args 作为 content
      while (i < args.length) {
        rewritten.push(args[i]);
        i++;
      }
      break;
    } else if (arg === "-t" || arg === "--task") {
      const taskId = args[i + 1] || "";
      i += 2;
      // 检查后续是否跟 -s / --fail / --cancel / -v
      if (i < args.length && (args[i] === "-s" || args[i] === "--set-output")) {
        const next = args[i + 1];
        if (next && next !== "-" && !next.startsWith("-")) {
          // 内联输出：-s "value"
          rewritten.push("writeback", "-t", taskId, "-s", next);
          i += 2;
        } else {
          // stdin 模式：-s - 或 -s 无参数
          rewritten.push("writeback", "-t", taskId);
          i += (next === "-") ? 2 : 1;
        }
      } else if (i < args.length && args[i] === "--fail") {
        const next = args[i + 1];
        if (next && next !== "-" && !next.startsWith("-")) {
          rewritten.push("fail", "-t", taskId, "-r", next);
          i += 2;
        } else {
          rewritten.push("fail", "-t", taskId);
          i += (next === "-") ? 2 : 1;
        }
      } else if (i < args.length && args[i] === "--cancel") {
        rewritten.push("cancel", "-t", taskId);
        i += 1;
      } else if (i < args.length && args[i] === "-v") {
        rewritten.push("wait", "-t", taskId);
        i += 1;
      } else if (i < args.length && args[i] === "-o") {
        rewritten.push("query", "-t", taskId, "-o");
        i += 1;
      } else {
        // 纯查询
        rewritten.push("query", "-t", taskId);
      }
    } else if (arg === "ls") {
      rewritten.push("list");
      i += 1;
      // ls 后可跟 project name
      while (i < args.length) {
        rewritten.push(args[i]);
        i++;
      }
    } else {
      // 保持原样（init, remove, list 等）
      rewritten.push(arg);
      i++;
    }
  }

  process.argv = [process.argv[0], process.argv[1], ...rewritten];
}

rewriteArgv();

// -- 确保 HOME 存在 --
initRegistry();
initDb();

const program = new Command();

program
  .name("vkanban")
  .description("Cross-project task dispatch and tracking CLI")
  .version("0.4.0");

cmdInit.register(program);
cmdDispatch.register(program);
cmdQuery.register(program);
cmdWriteback.register(program);
cmdFail.register(program);
cmdCancel.register(program);
cmdWait.register(program);
cmdList.register(program);
cmdRemove.register(program);

program.parse();
