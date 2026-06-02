# vkanban Daemon Worker 设计文档

## 背景与目标

当前 `vkanban -p <project> <content>` 在派发任务时会立即启动 `supervisor` 子进程，`supervisor` 再启动 `pi` 并等待其退出。该模型在普通 PowerShell 中可观察到异步效果，但在 OpenCode 的 shell 工具中会阻塞到任务完成。根因假设是 Windows Job Object 会跟踪调用方创建的整棵进程树，即使 Bun 使用 `detached: true` 和 `unref()`，也不能保证 `supervisor -> pi` 脱离调用方 Job Object。

本设计目标是将任务派发与任务执行彻底解耦：CLI 派发只负责写入 SQLite 并立即返回 `task_id`；长期运行的 daemon/worker 独立认领 `pending` 任务并启动 `pi`。daemon 可由用户手动运行，也可在 Windows 上安装为系统服务，从而避免 agent shell 等调用方等待执行进程树退出。

## 现状分析

相关代码文件：

- `src/commands/dispatch.ts`：当前派发命令插入任务后立即 `casPendingToRunning()`，再 `Bun.spawn([process.execPath, "run", supervisorEntry], { detached: true })` 启动 `supervisor`，并等待最多 `VKANBAN_CLAIM_TIMEOUT_MS` 确认 `claimed_at`。
- `src/supervisor.ts`：当前 supervisor 从环境变量读取 `VKANBAN_TASK_ID`、`VKANBAN_DB`、`VKANBAN_PROJECT_PATH`，CAS 写入 `claimed_at`，启动 `pi`，等待 `piProc.exited`，最后在未写回时兜底标记 `pi_exited_no_callback`。
- `src/tasks.ts`：任务状态机为 `pending -> running -> done|failed|cancelled`，现有 `casPendingToRunning()`、`casClaimTask()`、`casRunningToDone()`、`casRunningToFailed()`、`casRunningToCancelled()`。
- `src/db.ts`：SQLite schema 已有 `claimed_at`、`started_at`、`finished_at`、`status`、`error_code` 字段，并启用 WAL 与 `busy_timeout=5000`。
- `src/cli.ts`：负责将用户友好参数改写为 Commander 子命令。新增 daemon/service 命令时需要注册命令；若新增顶层短参数，也需在 `rewriteArgv()` 中处理。
- `src/commands/cancel.ts`：当前只允许取消 `running` 任务，不支持取消尚未被 daemon 认领的 `pending` 任务。
- `README.md`：需要更新命令说明、daemon 使用方式、Windows Service 说明和新的环境变量。
- `tests/e2e/*.test.ts`：现有 E2E 依赖派发即启动 supervisor 的行为，需要改为在测试内显式启动 daemon 或用 worker 单轮模式执行任务。

现有设计的问题不是 `stdio` 未关闭，而是执行进程由派发命令直接创建。只要调用方环境会等待进程树，派发命令就可能被长期任务拖住。

## 推荐架构

采用“CLI 入队 + daemon 执行 + service 托管”的架构。

### 任务派发

`vkanban -p <project> <content>` 只做以下事情：

1. 校验项目存在与 content 长度。
2. 插入 `pending` 任务。
3. 输出 `{"task_id":"..."}`。
4. 退出。

派发命令不再启动 `supervisor`，不再等待 `claimed_at`，不再依赖 `VKANBAN_CLAIM_TIMEOUT_MS`。这保证 OpenCode、CI、脚本、普通终端中的派发调用都只受 SQLite 写入耗时影响。

### Daemon Worker

新增 `vkanban daemon` 命令，作为长期运行进程：

1. 初始化 registry 与 DB。
2. 循环查询最早创建的 `pending` 任务。
3. 使用 CAS 将任务从 `pending` 改为 `running`，同时写入 `started_at` 与 `claimed_at`。
4. 为任务启动 `pi`。
5. 等待 `pi` 退出。
6. 若任务仍为 `running`，写入 `failed/pi_exited_no_callback` 兜底结果。
7. 继续处理下一条任务。

默认采用单 worker 串行执行。这样最小化并发取消、进程管理和跨项目资源竞争复杂度。后续可通过 `--concurrency <n>` 扩展，但本轮不实现并发。

### Windows Service

新增 service 管理命令，用于把 daemon 托管为 Windows 系统服务：

- `vkanban service install`：安装服务，服务命令指向 `bun run <cliPath> daemon`。
- `vkanban service uninstall`：卸载服务。
- `vkanban service start`：启动服务。
- `vkanban service stop`：停止服务。
- `vkanban service status`：查询服务状态。

Windows Service 不是新的执行逻辑，只是 daemon 的托管方式。服务进程独立于 OpenCode shell 创建，因此不被 agent shell 的 Job Object 等待链影响。

实现上优先使用 Windows 内置 `sc.exe`，避免引入 Node 生态 service 包。安装命令需要管理员权限；若权限不足，输出 JSON 错误并提示以管理员 PowerShell 运行。

## 命令设计

### `vkanban daemon`

参数：

- `--poll-interval-ms <ms>`：无 pending 任务时的轮询间隔，默认读取 `VKANBAN_DAEMON_POLL_INTERVAL_MS`，再默认 `1000`。
- `--once`：只尝试处理一轮任务后退出，主要用于测试和手动排障。

输出：

- 所有状态事件以 JSON Lines 输出到 stdout。
- 错误以 JSON Lines 输出到 stderr。

事件示例：

```json
{"event":"daemon_started","poll_interval_ms":1000}
{"event":"task_claimed","task_id":"abc123"}
{"event":"task_finished","task_id":"abc123","status":"done"}
```

### `vkanban service ...`

服务名默认 `vkanban-daemon`，可通过 `--name <name>` 覆盖。所有子命令都输出 JSON。

安装时可传：

- `--name <name>`：服务名。
- `--display-name <name>`：显示名，默认 `vkanban daemon`。
- `--start auto|demand`：启动类型，默认 `auto`。

## 数据流

### 派发流程

```text
opencode shell / PowerShell
  -> vkanban -p project content
  -> insert tasks(status='pending')
  -> print task_id
  -> exit
```

### 执行流程

```text
Windows Service / 手动终端
  -> vkanban daemon
  -> claim pending task with CAS
  -> spawn pi --vkanban <task_id> -p "execute your kanban task"
  -> pi calls vkanban -t <task_id> -s/--fail
  -> daemon fallback if pi exits without callback
```

## 状态机调整

状态机保持 `pending -> running -> done|failed|cancelled`，但状态责任调整：

- `dispatch`：只创建 `pending`。
- `daemon`：负责 `pending -> running` 和 `claimed_at`。
- `writeback/fail`：负责 `running -> done|failed`。
- `cancel`：应支持取消 `pending` 与 `running`。

取消语义：

- `pending` 任务取消：直接 `pending -> cancelled`。
- `running` 任务取消：沿用当前 `running -> cancelled`。本轮只标记取消，不强杀 `pi` 进程；强杀可作为后续功能接入 `src/kill.ts`。
- daemon 在 `pi` 退出后若发现任务已是 `cancelled`，不再写兜底失败。

## 模块拆分

新增或调整模块：

- `src/worker.ts`：封装单次认领与执行任务逻辑。导出 `runDaemon()`、`runWorkerOnce()`，便于 daemon 命令和测试复用。
- `src/commands/daemon.ts`：注册 `daemon` 命令，解析参数，调用 `runDaemon()`。
- `src/commands/service.ts`：注册 `service` 命令，封装 `sc.exe` 调用与 JSON 输出。
- `src/tasks.ts`：新增 `claimNextPendingTask()`、`casPendingToCancelled()`；保留现有 CAS 方法以减少破坏性。
- `src/commands/dispatch.ts`：删除 supervisor 启动和 claim 等待逻辑，仅插入任务并输出 task_id。
- `src/supervisor.ts`：逐步废弃。第一阶段可保留文件但不再由 dispatch 调用，避免破坏路径测试；后续确认无用后再删除。
- `src/cli.ts`：注册 `daemon` 与 `service` 命令。

## 环境变量

保留：

- `VKANBAN_HOME`
- `VKANBAN_WAIT_TIMEOUT_MS`
- `VKANBAN_CLI_OVERRIDE`
- `VKANBAN_PI_CMD`
- `VKANBAN_DEBUG`

新增：

- `VKANBAN_DAEMON_POLL_INTERVAL_MS`：daemon 空闲轮询间隔，默认 `1000`。

弱化或废弃：

- `VKANBAN_CLAIM_TIMEOUT_MS`：dispatch 不再等待 claim，文档标记为 legacy。
- `VKANBAN_SUPERVISOR_OVERRIDE`：dispatch 不再使用，文档标记为 legacy。

## 错误处理

- daemon 启动失败：输出 JSON 错误并非 0 退出。
- claim 竞争失败：跳过该任务并继续轮询。
- `pi` spawn 失败：将任务标记为 `failed/spawn_failed`。
- `pi` 未写回即退出：若任务仍为 `running`，标记为 `failed/pi_exited_no_callback`。
- service 安装权限不足：输出 `{ "status":"error", "message":"Administrator privileges required" }`。
- service 命令仅在 Windows 支持；非 Windows 输出 JSON 错误。

## 测试策略

单元测试：

- `claimNextPendingTask()` 只认领最早 pending 任务，并原子写入 `running/started_at/claimed_at`。
- `casPendingToCancelled()` 可取消 pending，不能取消终态任务。
- worker 在 `pi` 正常写回时不覆盖结果。
- worker 在 `pi` 未写回时写入 fallback failure。

E2E 测试：

- 派发任务后 CLI 立即返回，任务初始状态为 `pending`。
- 启动 `vkanban daemon --once` 后任务进入终态。
- `vkanban -t <id> -v` 仍可等待 daemon 处理后的终态。
- 取消 pending 任务后 daemon 不执行该任务。

Service 测试：

- 不在自动化测试中真正安装 Windows Service，避免管理员权限和机器状态副作用。
- 对 `service` 命令的参数构造进行单元测试；实际安装作为手动验证步骤记录在 README。

## 迁移计划

1. 先实现 worker/daemon 并改造 dispatch。
2. 更新 cancel 支持 pending。
3. 更新 E2E 测试从“dispatch 自动执行”改为“dispatch 入队 + daemon 执行”。
4. 增加 service 管理命令。
5. 更新 README 与环境变量说明。
6. 保留 `src/supervisor.ts` 一个版本周期，避免已有覆盖路径立即失效；文档标记为 legacy。

## 非目标

- 本轮不实现多 worker 并发。
- 本轮不实现取消时强杀 `pi` 进程。
- 本轮不实现 Linux systemd 或 macOS launchd 安装命令。
- 本轮不引入额外 npm 包管理 Windows Service。
- 本轮不改变 `pi` 的 `--vkanban` 回调协议。

## 自检记录

- 未保留 `TBD`、`TODO` 或未决占位。
- 设计保持单一主线：CLI 入队，daemon 执行，Windows Service 托管 daemon。
- 状态机、错误码、测试策略与现有 SQLite schema 兼容。
- 明确了本轮非目标，避免把并发、强杀、跨平台服务托管混入第一版实现。
