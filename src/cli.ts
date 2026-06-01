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

const program = new Command();

program
  .name("vkanban")
  .description("Cross-project task dispatch and tracking CLI")
  .version("0.4.0");

// 初始化
initRegistry();
initDb();

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
