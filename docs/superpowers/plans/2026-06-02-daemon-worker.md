# Daemon Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `vkanban -p` 改为只入队并立即返回，由独立 `vkanban daemon` 和 Windows Service 托管机制负责执行任务。

**Architecture:** CLI dispatch 只写入 `pending` 任务；daemon 串行 CAS 认领最早 `pending` 任务并启动 `pi`；Windows Service 命令只负责通过 `sc.exe` 托管 daemon，不引入新的执行路径。

**Tech Stack:** TypeScript, Bun runtime, Commander, `bun:sqlite`, Bun test runner, Windows `sc.exe`.

**Design Spec:** `docs/superpowers/specs/2026-06-02-daemon-worker-design.md`

---

## File Structure

- Modify `src/tasks.ts`：新增 pending 认领和 pending 取消 CAS 方法，保留已有运行态 CAS 方法。
- Modify `src/commands/dispatch.ts`：删除 supervisor spawn、claim 等待和相关环境变量解析，只保留入队返回。
- Create `src/worker.ts`：封装 daemon 可复用的单轮处理与循环处理逻辑。
- Create `src/commands/daemon.ts`：注册 `vkanban daemon` 命令，解析 `--once` 和 `--poll-interval-ms`。
- Create `src/service.ts`：封装 Windows Service 命令参数构造和 `sc.exe` 调用。
- Create `src/commands/service.ts`：注册 `vkanban service install|uninstall|start|stop|status` 命令。
- Modify `src/commands/cancel.ts`：允许取消 `pending` 和 `running`，终态仍失败。
- Modify `src/cli.ts`：注册 daemon 和 service 命令。
- Modify `README.md`：更新 daemon、service、环境变量和派发语义。
- Modify `tests/unit/tasks.test.ts`：覆盖 `claimNextPendingTask()` 和 `casPendingToCancelled()`。
- Create `tests/unit/worker.test.ts`：覆盖 worker 正常写回、spawn 失败、无任务单轮退出。
- Create `tests/unit/service.test.ts`：覆盖 service 命令构造，不实际安装系统服务。
- Modify `tests/e2e/full_flow.test.ts`：改为 `dispatch -> daemon --once -> done`。
- Modify `tests/e2e/picrash.test.ts`：改为 worker/daemon 兜底测试，不直接调用 legacy supervisor。
- Modify `tests/e2e/cancel.test.ts` 和 `tests/e2e/happy_path.test.ts`：补齐 pending cancel 与 dispatch 初始 pending 断言。

---

### Task 1: Task State CAS Helpers

**Files:**
- Modify: `src/tasks.ts`
- Test: `tests/unit/tasks.test.ts`

- [ ] **Step 1: Write failing tests for pending claim and pending cancel**

Add imports in `tests/unit/tasks.test.ts`:

```ts
import {
  insertTask,
  casPendingToRunning,
  casClaimTask,
  casRunningToDone,
  casRunningToFailed,
  casRunningToCancelled,
  casPendingToCancelled,
  claimNextPendingTask,
  getTaskById,
  listTasksByProject,
} from "../../src/tasks";
```

Append tests inside `describe("tasks — CAS transitions", ...)`:

```ts
  test("claimNextPendingTask claims oldest pending task", async () => {
    const first = nanoid(12);
    const second = nanoid(12);
    insertTask({ id: first, project_name: projectName, project_path: TEST_HOME, content: "first" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    insertTask({ id: second, project_name: projectName, project_path: TEST_HOME, content: "second" });

    const claimed = claimNextPendingTask();

    expect(claimed!.id).toBe(first);
    expect(claimed!.status).toBe("running");
    expect(claimed!.claimed_at).toBeTruthy();
    expect(claimed!.started_at).toBeTruthy();
    expect(getTaskById(second)!.status).toBe("pending");
  });

  test("claimNextPendingTask returns null when no pending tasks exist", () => {
    const id = nanoid(12);
    insertTask({ id, project_name: projectName, project_path: TEST_HOME, content: "running" });
    casPendingToRunning(id);

    const claimed = claimNextPendingTask();

    expect(claimed).toBeNull();
  });

  test("casPendingToCancelled transitions pending→cancelled", () => {
    const id = nanoid(12);
    insertTask({ id, project_name: projectName, project_path: TEST_HOME, content: "cancel pending" });

    const result = casPendingToCancelled(id);

    expect(result.changed).toBe(true);
    expect(result.status).toBe("cancelled");
    expect(result.error_code).toBe("cancelled");
  });

  test("casPendingToCancelled rejects running task", () => {
    const id = nanoid(12);
    insertTask({ id, project_name: projectName, project_path: TEST_HOME, content: "already running" });
    casPendingToRunning(id);

    const result = casPendingToCancelled(id);

    expect(result.changed).toBe(false);
    expect(result.status).toBe("running");
  });
```

- [ ] **Step 2: Run tests and verify failure**

Run: `bun test tests/unit/tasks.test.ts`

Expected: FAIL because `casPendingToCancelled` and `claimNextPendingTask` are not exported from `src/tasks.ts`.

- [ ] **Step 3: Implement task helpers**

Add these exports to `src/tasks.ts` after `casClaimTask()`:

```ts
export function claimNextPendingTask(): TaskRow | null {
  const now = new Date().toISOString();
  const db = getDb();
  const candidate = db.query(
    `SELECT id FROM tasks WHERE status='pending' ORDER BY created_at ASC LIMIT 1`
  ).get() as { id: string } | undefined;

  if (!candidate) return null;

  const result = db.query(
    `UPDATE tasks SET status='running', started_at=?, claimed_at=?, updated_at=?
     WHERE id=? AND status='pending'`
  ).run(now, now, now, candidate.id);

  if (result.changes !== 1) return null;
  return getTaskById(candidate.id);
}

export function casPendingToCancelled(taskId: string): { changed: boolean; status: string; error_code: string | null } {
  const now = new Date().toISOString();
  const db = getDb();
  const result = db.query(
    `UPDATE tasks SET status='cancelled', error_code='cancelled', finished_at=?, updated_at=?
     WHERE id=? AND status='pending'`
  ).run(now, now, taskId);
  const row = db.query(`SELECT status, error_code FROM tasks WHERE id=?`).get(taskId) as
    { status: string; error_code: string | null } | undefined;
  return {
    changed: result.changes === 1,
    status: row?.status ?? "unknown",
    error_code: row?.error_code ?? null,
  };
}
```

- [ ] **Step 4: Run tests and verify pass**

Run: `bun test tests/unit/tasks.test.ts`

Expected: PASS.

- [ ] **Step 5: Checkpoint**

Run: `git diff -- src/tasks.ts tests/unit/tasks.test.ts`

Expected: diff only contains new task helper tests and implementations. Do not commit unless the user explicitly authorizes commits for this session.

---

### Task 2: Dispatch Becomes Enqueue-Only

**Files:**
- Modify: `src/commands/dispatch.ts`
- Modify: `tests/e2e/happy_path.test.ts`

- [ ] **Step 1: Write failing dispatch assertion**

Update the dispatch test in `tests/e2e/happy_path.test.ts`:

```ts
describe("e2e — dispatch (-p)", () => {
  test("-p enqueues a pending task and returns task_id", async () => {
    const result = await $`bun run ${CLI} -p my_app "e2e dispatch test"`.json();
    expect(result.task_id).toBeTruthy();
    const task = getTaskById(result.task_id);
    expect(task!.project_name).toBe("my_app");
    expect(task!.content).toBe("e2e dispatch test");
    expect(task!.status).toBe("pending");
    expect(task!.claimed_at).toBeNull();
    expect(task!.started_at).toBeNull();
  });
});
```

- [ ] **Step 2: Run test and verify failure**

Run: `bun test tests/e2e/happy_path.test.ts`

Expected: FAIL because current dispatch transitions the task to `running` and may spawn supervisor.

- [ ] **Step 3: Simplify dispatch implementation**

Replace `src/commands/dispatch.ts` imports with:

```ts
import type { Command } from "commander";
import { nanoid } from "nanoid";
import { getProject } from "../registry";
import { insertTask } from "../tasks";
```

Replace the action body after content validation with:

```ts
      const id = nanoid(12);

      insertTask({ id, project_name: project.name, project_path: project.path, content });

      console.log(JSON.stringify({ task_id: id }));
```

Remove all supervisor path resolution, `Bun.spawn`, claim polling, and `casRunningToFailed` logic from `src/commands/dispatch.ts`.

- [ ] **Step 4: Run targeted E2E**

Run: `bun test tests/e2e/happy_path.test.ts`

Expected: PASS for dispatch and existing query/writeback/fail/list/cancel/wait tests.

- [ ] **Step 5: Checkpoint**

Run: `git diff -- src/commands/dispatch.ts tests/e2e/happy_path.test.ts`

Expected: dispatch no longer imports `path`, `which`, `resolveSupervisorEntrypoint`, `resolveCliPath`, `resolveVkanbanHome`, `casPendingToRunning`, `casRunningToFailed`, or `getTaskById`.

---

### Task 3: Worker Core

**Files:**
- Create: `src/worker.ts`
- Create: `tests/unit/worker.test.ts`

- [ ] **Step 1: Write worker tests**

Create `tests/unit/worker.test.ts`:

```ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { initDb, closeDb } from "../../src/db";
import { initRegistry, registerProject } from "../../src/registry";
import { insertTask, getTaskById } from "../../src/tasks";
import { runWorkerOnce } from "../../src/worker";

let testHome: string;
let cliPath: string;

beforeEach(() => {
  testHome = path.join(os.tmpdir(), "vkanban_worker_test_" + Date.now() + "_" + Math.random().toString(16).slice(2));
  fs.mkdirSync(testHome, { recursive: true });
  Bun.env.VKANBAN_HOME = testHome;
  initRegistry();
  initDb();
  registerProject("worker_project", testHome);
  cliPath = path.resolve("src/cli.ts");
  Bun.env.VKANBAN_CLI_OVERRIDE = cliPath;
});

afterEach(() => {
  closeDb();
  delete Bun.env.VKANBAN_PI_CMD;
  delete Bun.env.VKANBAN_CLI_OVERRIDE;
  fs.rmSync(testHome, { recursive: true, force: true });
});

describe("worker", () => {
  test("runWorkerOnce returns idle when no pending task exists", async () => {
    const result = await runWorkerOnce();
    expect(result.status).toBe("idle");
  });

  test("runWorkerOnce executes fake pi and preserves writeback", async () => {
    const fakePiPath = path.join(testHome, "fake_pi.ts");
    fs.writeFileSync(fakePiPath, `
      const id = Bun.env.VKANBAN_TASK_ID;
      const cli = Bun.env.VKANBAN_CLI;
      const proc = Bun.spawn([process.execPath, "run", cli!, "-t", id!, "-s", "worker done"], {
        stdio: ["ignore", "ignore", "ignore"],
      });
      process.exit(await proc.exited);
    `);
    Bun.env.VKANBAN_PI_CMD = `bun run ${fakePiPath}`;
    const task = insertTask({ id: "worker_done", project_name: "worker_project", project_path: testHome, content: "run" });

    const result = await runWorkerOnce();
    const stored = getTaskById(task.id)!;

    expect(result.status).toBe("processed");
    expect(result.task_id).toBe(task.id);
    expect(stored.status).toBe("done");
    expect(stored.output).toBe("worker done");
  }, 15000);

  test("runWorkerOnce marks spawn failure", async () => {
    Bun.env.VKANBAN_PI_CMD = "nonexistent_pi_command_xyz";
    const task = insertTask({ id: "worker_spawn", project_name: "worker_project", project_path: testHome, content: "run" });

    const result = await runWorkerOnce();
    const stored = getTaskById(task.id)!;

    expect(result.status).toBe("processed");
    expect(stored.status).toBe("failed");
    expect(stored.error_code).toBe("spawn_failed");
  }, 15000);
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `bun test tests/unit/worker.test.ts`

Expected: FAIL because `src/worker.ts` does not exist.

- [ ] **Step 3: Implement worker core**

Create `src/worker.ts`:

```ts
import * as path from "node:path";
import { which } from "bun";
import { casRunningToFailed, claimNextPendingTask, getTaskById } from "./tasks";
import { resolveCliPath, resolveVkanbanHome } from "./paths";

export interface WorkerRunResult {
  status: "idle" | "processed";
  task_id?: string;
}

export interface DaemonOptions {
  pollIntervalMs: number;
  once?: boolean;
}

function splitCommand(raw: string): string[] {
  return raw.split(/\s+/).filter(Boolean);
}

function jsonStdout(value: unknown): void {
  console.log(JSON.stringify(value));
}

function jsonStderr(value: unknown): void {
  console.error(JSON.stringify(value));
}

export async function runWorkerOnce(): Promise<WorkerRunResult> {
  const task = claimNextPendingTask();
  if (!task) return { status: "idle" };

  jsonStdout({ event: "task_claimed", task_id: task.id });

  const rawPiCmd = Bun.env.VKANBAN_PI_CMD || "pi";
  const piCmdParts = splitCommand(which(rawPiCmd) || rawPiCmd);
  const cliPath = resolveCliPath();
  const homePath = resolveVkanbanHome();
  const dbPath = path.join(homePath, "data.db");
  const isDebug = Bun.env.VKANBAN_DEBUG === "1";
  const prompt = "execute your kanban task";
  const piArgs = isDebug
    ? [...piCmdParts, "--vkanban", task.id, prompt]
    : [...piCmdParts, "--vkanban", task.id, "-p", prompt];

  let piProc;
  try {
    piProc = Bun.spawn(piArgs, {
      cwd: task.project_path,
      env: {
        ...Bun.env,
        VKANBAN_TASK_ID: task.id,
        VKANBAN_CLI: cliPath,
        VKANBAN_HOME: homePath,
        VKANBAN_DB: dbPath,
        VKANBAN_PROJECT_PATH: task.project_path,
      },
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch (error) {
    casRunningToFailed(task.id, "spawn_failed", String(error));
    jsonStderr({ event: "task_failed", task_id: task.id, error_code: "spawn_failed", message: String(error) });
    return { status: "processed", task_id: task.id };
  }

  const exitCode = await piProc.exited;
  const current = getTaskById(task.id);
  if (current?.status === "running") {
    const message = `pi exited (code=${exitCode}) without writing back. Use: vkanban -t ${task.id} -s "<output>" or --fail "<reason>"`;
    casRunningToFailed(task.id, "pi_exited_no_callback", message);
  }

  const finalTask = getTaskById(task.id);
  jsonStdout({ event: "task_finished", task_id: task.id, status: finalTask?.status ?? "unknown" });
  return { status: "processed", task_id: task.id };
}

export async function runDaemon(options: DaemonOptions): Promise<void> {
  jsonStdout({ event: "daemon_started", poll_interval_ms: options.pollIntervalMs, once: options.once === true });
  while (true) {
    const result = await runWorkerOnce();
    if (options.once) return;
    if (result.status === "idle") {
      await new Promise((resolve) => setTimeout(resolve, options.pollIntervalMs));
    }
  }
}
```

- [ ] **Step 4: Run worker tests**

Run: `bun test tests/unit/worker.test.ts`

Expected: PASS.

- [ ] **Step 5: Checkpoint**

Run: `git diff -- src/worker.ts tests/unit/worker.test.ts`

Expected: worker has no dependency on `src/supervisor.ts` and uses `claimNextPendingTask()`.

---

### Task 4: Daemon Command Registration

**Files:**
- Create: `src/commands/daemon.ts`
- Modify: `src/cli.ts`
- Test: `tests/e2e/full_flow.test.ts`

- [ ] **Step 1: Update full-flow E2E for daemon**

Replace the test body in `tests/e2e/full_flow.test.ts` with:

```ts
  test("vkanban -p → daemon --once → pi → writeback done", async () => {
    const dispatchOutput = await $`bun run ${CLI} -p full_test "full flow test"`.text();
    const dispatchResult = JSON.parse(dispatchOutput.trim().split("\n").pop()!);
    expect(dispatchResult.task_id).toBeTruthy();
    const tid = dispatchResult.task_id;

    expect(getTaskById(tid)!.status).toBe("pending");

    const daemonOutput = await $`bun run ${CLI} daemon --once`.text();
    expect(daemonOutput).toContain("task_claimed");
    expect(daemonOutput).toContain("task_finished");

    const finalTask = getTaskById(tid);
    expect(finalTask).toBeTruthy();
    expect(finalTask!.status).toBe("done");
    expect(finalTask!.output).toContain("fake pi done");
  }, 30000);
```

Update the test title from `supervisor` to `daemon` if present in the `describe` or comments.

- [ ] **Step 2: Run test and verify failure**

Run: `bun test tests/e2e/full_flow.test.ts`

Expected: FAIL because `daemon` command is not registered.

- [ ] **Step 3: Create daemon command**

Create `src/commands/daemon.ts`:

```ts
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
```

- [ ] **Step 4: Register command in CLI**

Add import in `src/cli.ts`:

```ts
import * as cmdDaemon from "./commands/daemon";
```

Add registration before list/remove registration:

```ts
cmdDaemon.register(program);
```

- [ ] **Step 5: Run full-flow E2E**

Run: `bun test tests/e2e/full_flow.test.ts`

Expected: PASS.

- [ ] **Step 6: Checkpoint**

Run: `git diff -- src/commands/daemon.ts src/cli.ts tests/e2e/full_flow.test.ts`

Expected: `daemon --once` is used by tests; dispatch no longer auto-executes tasks.

---

### Task 5: Pending Cancellation

**Files:**
- Modify: `src/commands/cancel.ts`
- Modify: `tests/e2e/cancel.test.ts`
- Modify: `tests/e2e/happy_path.test.ts`

- [ ] **Step 1: Write pending cancel E2E**

Add to `tests/e2e/cancel.test.ts`:

```ts
  test("-t --cancel transitions pending task to cancelled", async () => {
    const id = nanoid(12);
    insertTask({ id, project_name: "my_app", project_path: E2E_HOME, content: "pending cancel" });

    const result = await $`bun run ${CLI} -t ${id} --cancel`.json();

    expect(result.new_status).toBe("cancelled");
    expect(getTaskById(id)!.status).toBe("cancelled");
    expect(getTaskById(id)!.error_code).toBe("cancelled");
  });
```

Change the done-task failure expectation in `tests/e2e/cancel.test.ts`:

```ts
    expect(out).toContain("cannot be cancelled");
```

- [ ] **Step 2: Run cancel E2E and verify failure**

Run: `bun test tests/e2e/cancel.test.ts`

Expected: FAIL because current command rejects non-running tasks.

- [ ] **Step 3: Update cancel command**

Replace `src/commands/cancel.ts` imports:

```ts
import type { Command } from "commander";
import { casPendingToCancelled, casRunningToCancelled, getTaskById } from "../tasks";
```

Replace status handling inside `.action(...)` after task existence check:

```ts
      if (task.status !== "pending" && task.status !== "running") {
        console.error(JSON.stringify({
          status: "error",
          message: `Task cannot be cancelled (current: ${task.status})`,
        }));
        process.exit(2);
      }

      const result = task.status === "pending"
        ? casPendingToCancelled(opts.task)
        : casRunningToCancelled(opts.task);
```

Keep the success and race-detected output shape unchanged.

- [ ] **Step 4: Run cancel and happy path tests**

Run: `bun test tests/e2e/cancel.test.ts tests/e2e/happy_path.test.ts`

Expected: PASS.

- [ ] **Step 5: Checkpoint**

Run: `git diff -- src/commands/cancel.ts tests/e2e/cancel.test.ts tests/e2e/happy_path.test.ts`

Expected: pending cancellation is supported and terminal task cancellation still fails.

---

### Task 6: Pi Crash Fallback Through Worker

**Files:**
- Modify: `tests/e2e/picrash.test.ts`
- Uses: `src/worker.ts`

- [ ] **Step 1: Rewrite picrash E2E to use daemon worker**

Replace `tests/e2e/picrash.test.ts` imports:

```ts
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { nanoid } from "nanoid";
import { initDb, closeDb } from "../../src/db";
import { initRegistry, registerProject } from "../../src/registry";
import { insertTask, getTaskById } from "../../src/tasks";
import { runWorkerOnce } from "../../src/worker";
```

Replace the test with:

```ts
describe("e2e — daemon pi crash兜底", () => {
  test("worker兜底: pi 启动失败 → spawn_failed", async () => {
    const id = nanoid(12);
    insertTask({ id, project_name: "proj_sup", project_path: E2E_HOME, content: "test" });
    Bun.env.VKANBAN_PI_CMD = "nonexistent_pi_command_xyz";

    const result = await runWorkerOnce();
    const task = getTaskById(id);

    expect(result.status).toBe("processed");
    expect(task!.status).toBe("failed");
    expect(task!.error_code).toBe("spawn_failed");
  }, 15000);
});
```

Remove `resolveSupervisorEntrypoint()`, `casPendingToRunning()`, and direct `Bun.spawn(["bun", "run", SUPERVISOR_ENTRY], ...)` usage from this file.

- [ ] **Step 2: Run picrash test**

Run: `bun test tests/e2e/picrash.test.ts`

Expected: PASS.

- [ ] **Step 3: Checkpoint**

Run: `git diff -- tests/e2e/picrash.test.ts`

Expected: test exercises worker fallback rather than legacy supervisor.

---

### Task 7: Windows Service Helpers and Command

**Files:**
- Create: `src/service.ts`
- Create: `src/commands/service.ts`
- Modify: `src/cli.ts`
- Create: `tests/unit/service.test.ts`

- [ ] **Step 1: Write service unit tests**

Create `tests/unit/service.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import * as path from "node:path";
import { buildServiceCommand } from "../../src/service";

describe("service command builder", () => {
  test("builds install command with defaults", () => {
    const cliPath = path.resolve("src/cli.ts");
    const result = buildServiceCommand("install", {
      serviceName: "vkanban-daemon",
      displayName: "vkanban daemon",
      startType: "auto",
      cliPath,
      bunPath: "C:\\bin\\bun.exe",
    });

    expect(result.executable).toBe("sc.exe");
    expect(result.args[0]).toBe("create");
    expect(result.args).toContain("vkanban-daemon");
    expect(result.args.join(" ")).toContain("binPath=");
    expect(result.args.join(" ")).toContain("daemon");
    expect(result.args.join(" ")).toContain("start=");
    expect(result.args.join(" ")).toContain("auto");
  });

  test("builds lifecycle commands", () => {
    expect(buildServiceCommand("start", { serviceName: "vk" }).args).toEqual(["start", "vk"]);
    expect(buildServiceCommand("stop", { serviceName: "vk" }).args).toEqual(["stop", "vk"]);
    expect(buildServiceCommand("uninstall", { serviceName: "vk" }).args).toEqual(["delete", "vk"]);
    expect(buildServiceCommand("status", { serviceName: "vk" }).args).toEqual(["query", "vk"]);
  });
});
```

- [ ] **Step 2: Run service tests and verify failure**

Run: `bun test tests/unit/service.test.ts`

Expected: FAIL because `src/service.ts` does not exist.

- [ ] **Step 3: Implement service helper**

Create `src/service.ts`:

```ts
export type ServiceAction = "install" | "uninstall" | "start" | "stop" | "status";
export type ServiceStartType = "auto" | "demand";

export interface ServiceCommandOptions {
  serviceName: string;
  displayName?: string;
  startType?: ServiceStartType;
  cliPath?: string;
  bunPath?: string;
}

export interface BuiltServiceCommand {
  executable: "sc.exe";
  args: string[];
}

export function buildServiceCommand(action: ServiceAction, options: ServiceCommandOptions): BuiltServiceCommand {
  const serviceName = options.serviceName;
  if (action === "install") {
    if (!options.cliPath || !options.bunPath) {
      throw new Error("cliPath and bunPath are required for service install");
    }
    const displayName = options.displayName || "vkanban daemon";
    const startType = options.startType || "auto";
    const binPath = `\"${options.bunPath}\" run \"${options.cliPath}\" daemon`;
    return {
      executable: "sc.exe",
      args: [
        "create",
        serviceName,
        "binPath=",
        binPath,
        "DisplayName=",
        displayName,
        "start=",
        startType,
      ],
    };
  }

  const commandByAction: Record<Exclude<ServiceAction, "install">, string> = {
    uninstall: "delete",
    start: "start",
    stop: "stop",
    status: "query",
  };

  return { executable: "sc.exe", args: [commandByAction[action], serviceName] };
}

export async function executeServiceCommand(command: BuiltServiceCommand): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([command.executable, ...command.args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}
```

- [ ] **Step 4: Create service command**

Create `src/commands/service.ts`:

```ts
import type { Command } from "commander";
import { which } from "bun";
import { resolveCliPath } from "../paths";
import { buildServiceCommand, executeServiceCommand, type ServiceAction, type ServiceStartType } from "../service";

const DEFAULT_SERVICE_NAME = "vkanban-daemon";

function ensureWindows(): void {
  if (process.platform !== "win32") {
    console.error(JSON.stringify({ status: "error", message: "service command is only supported on Windows" }));
    process.exit(1);
  }
}

async function runServiceAction(action: ServiceAction, opts: { name?: string; displayName?: string; start?: ServiceStartType }): Promise<void> {
  ensureWindows();
  const serviceName = opts.name || DEFAULT_SERVICE_NAME;
  const bunPath = which("bun") || process.execPath;
  const command = buildServiceCommand(action, {
    serviceName,
    displayName: opts.displayName,
    startType: opts.start,
    cliPath: resolveCliPath(),
    bunPath,
  });
  const result = await executeServiceCommand(command);
  const payload = { status: result.exitCode === 0 ? "ok" : "error", action, service_name: serviceName, stdout: result.stdout, stderr: result.stderr };
  if (result.exitCode === 0) {
    console.log(JSON.stringify(payload));
  } else {
    console.error(JSON.stringify(payload));
    process.exit(result.exitCode);
  }
}

export function register(program: Command): void {
  const service = program.command("service").description("Manage vkanban daemon Windows service");

  service.command("install")
    .option("--name <name>", "Service name", DEFAULT_SERVICE_NAME)
    .option("--display-name <name>", "Service display name", "vkanban daemon")
    .option("--start <type>", "Service start type: auto or demand", "auto")
    .action((opts: { name?: string; displayName?: string; start?: ServiceStartType }) => runServiceAction("install", opts));

  service.command("uninstall")
    .option("--name <name>", "Service name", DEFAULT_SERVICE_NAME)
    .action((opts: { name?: string }) => runServiceAction("uninstall", opts));

  service.command("start")
    .option("--name <name>", "Service name", DEFAULT_SERVICE_NAME)
    .action((opts: { name?: string }) => runServiceAction("start", opts));

  service.command("stop")
    .option("--name <name>", "Service name", DEFAULT_SERVICE_NAME)
    .action((opts: { name?: string }) => runServiceAction("stop", opts));

  service.command("status")
    .option("--name <name>", "Service name", DEFAULT_SERVICE_NAME)
    .action((opts: { name?: string }) => runServiceAction("status", opts));
}
```

- [ ] **Step 5: Register service command in CLI**

Add import in `src/cli.ts`:

```ts
import * as cmdService from "./commands/service";
```

Add registration after daemon registration:

```ts
cmdService.register(program);
```

- [ ] **Step 6: Run service tests**

Run: `bun test tests/unit/service.test.ts`

Expected: PASS.

- [ ] **Step 7: Checkpoint**

Run: `git diff -- src/service.ts src/commands/service.ts src/cli.ts tests/unit/service.test.ts`

Expected: tests only validate command construction; no test installs a real service.

---

### Task 8: README and Legacy Path Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-06-02-daemon-worker-design.md` only if implementation discovers mismatch with the approved design.

- [ ] **Step 1: Update README command list**

In `README.md`, update quick start to show daemon requirement:

```md
# 启动 daemon（另开终端或安装为系统服务）
vkanban daemon

# 发布任务：只入队并立即返回 task_id
vkanban -p my_project "帮我检查一下 xxx"
```

Add command rows:

```md
| `vkanban daemon [--once] [--poll-interval-ms <ms>]` | 运行任务执行 daemon |
| `vkanban service install|uninstall|start|stop|status` | Windows Service 管理 daemon |
```

- [ ] **Step 2: Update environment section**

Replace legacy environment rows with:

```md
| `VKANBAN_DAEMON_POLL_INTERVAL_MS` | daemon 空闲轮询间隔 (默认 1000ms) |
| `VKANBAN_CLAIM_TIMEOUT_MS` | legacy：dispatch 不再等待 claim |
| `VKANBAN_SUPERVISOR_OVERRIDE` | legacy：dispatch 不再启动 supervisor |
```

- [ ] **Step 3: Add Windows Service section**

Add to `README.md`:

````md
## Windows Service

以管理员 PowerShell 运行：

```powershell
vkanban service install
vkanban service start
vkanban service status
```

卸载：

```powershell
vkanban service stop
vkanban service uninstall
```

系统服务只托管 `vkanban daemon`。任务派发命令不会直接启动 `pi`，因此在 OpenCode、CI 或其他会等待进程树的环境中也会快速返回。
````

- [ ] **Step 4: Check README formatting**

Run: `git diff -- README.md`

Expected: README clearly says dispatch is enqueue-only and daemon/service performs execution.

---

### Task 9: Full Test Update and Verification

**Files:**
- Modify any failing tests under `tests/unit` and `tests/e2e` that still assume dispatch auto-starts supervisor.

- [ ] **Step 1: Run unit tests**

Run: `bun test tests/unit`

Expected: PASS.

- [ ] **Step 2: Fix unit failures caused by planned behavior**

If `tests/unit/paths.test.ts` still passes, leave `resolveSupervisorEntrypoint()` unchanged. If a unit test fails only because service/daemon command registration changes CLI help output, update the assertion to the new command list. Do not remove legacy supervisor path tests in this task.

- [ ] **Step 3: Run E2E tests**

Run: `bun test tests/e2e`

Expected: PASS.

- [ ] **Step 4: Fix E2E failures caused by planned behavior**

Search for old assumptions:

Run: `rg "supervisor|casPendingToRunning\(|status\)\.toBe\(\"running\"|VKANBAN_CLAIM_TIMEOUT_MS" tests src README.md`

Expected remaining references are either legacy docs/tests for `resolveSupervisorEntrypoint()` or deliberate `running` setup for writeback/fail/cancel tests.

- [ ] **Step 5: Run full suite**

Run: `bun test`

Expected: PASS.

- [ ] **Step 6: Inspect final diff**

Run: `git diff --stat`

Expected: changed files match the File Structure section; no unrelated files are modified.

---

### Task 10: Review Package Preparation

**Files:**
- Create: `docs/changelog-2026-06-02-0001.md`

- [ ] **Step 1: Create changelog for review**

Create `docs/changelog-2026-06-02-0001.md`:

```md
# Changelog 2026-06-02-0001

## Design Reference

- `docs/superpowers/specs/2026-06-02-daemon-worker-design.md`
- `docs/superpowers/plans/2026-06-02-daemon-worker.md`

## Summary

- Changed dispatch from immediate supervisor spawn to enqueue-only behavior.
- Added daemon worker execution path for pending tasks.
- Added Windows Service management commands for daemon hosting.
- Added pending cancellation support.
- Updated tests and README for daemon-based execution.

## Verification

- `bun test tests/unit`
- `bun test tests/e2e`
- `bun test`

## Review-0001

Reviewer: @oracle

Result: awaiting review

Action Items:
- Await @oracle review feedback.
```

- [ ] **Step 2: Prepare review request**

Run: `git diff -- docs/changelog-2026-06-02-0001.md src tests README.md`

Expected: review package includes implementation, tests, docs, changelog, and references to the approved design and this plan.

- [ ] **Step 3: Orchestrator review gate**

Ask @oracle to review the full diff and append review findings to `docs/changelog-2026-06-02-0001.md` under `Review-0001`. If @oracle returns action items, implement them one by one, append a remediation report to the changelog, rerun relevant tests, and request another review round until approved.

---

## Self-Review

- Spec coverage: dispatch enqueue-only is covered by Task 2; daemon worker by Tasks 3–4; pending cancel by Task 5; worker fallback by Task 6; Windows Service by Task 7; README/env docs by Task 8; verification by Task 9; review package by Task 10.
- Placeholder scan: no `TBD` placeholders remain; implementation steps include concrete file paths, commands, expected outcomes, and code snippets.
- Type consistency: task helper names are `claimNextPendingTask()` and `casPendingToCancelled()` throughout; worker exports are `runWorkerOnce()` and `runDaemon()` throughout; service helper is `buildServiceCommand()` throughout.
