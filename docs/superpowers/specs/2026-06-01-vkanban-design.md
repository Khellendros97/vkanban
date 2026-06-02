# vkanban CLI 工具 — 设计规格 (v0.4)

> 日期: 2026-06-01
> 状态: 已通过两轮 Oracle 审查，待用户最终确认
> 路径: `docs/superpowers/specs/2026-06-01-vkanban-design.md`

---

## 一、背景与目标

### 1.1 问题

在多项目协作中，开发者经常需要：
- A 项目希望获取 B 项目的某个接口文档
- A 项目希望触发 B 项目的一次异步任务
- 协调者希望跟踪跨项目的任务执行状态

现有做法（手工沟通、临时脚本）缺乏统一的元信息记录、状态追踪与可重入入口。

### 1.2 目标

仿照 hermes 看板系统，构建一个**轻量 CLI 工具 `vkanban`**，提供：

- 跨项目的**任务发布**与**元信息持久化**
- 跨项目的**任务状态追踪**
- 通过 `pi` coding agent 扩展作为**任务执行者**

### 1.3 非目标 (v0)

- 不实现任务队列、调度器、worker pool
- 不做 Web UI
- 不做权限/多用户/审计
- 不做远程部署
- 不做 `pi` 扩展本身（由他人负责）

### 1.4 显式 v0 范围

| 命令 | 范围 |
| --- | --- |
| `vkanban init <name> [dir]` | 在本地注册项目 |
| `vkanban -p <name> <content...>` | 派发任务（异步，立即返回 task_id） |
| `vkanban -t <id>` | 查询任务状态 |
| `vkanban -t <id> -s <output>` | 写回任务输出（pi 插件用） |
| `vkanban -t <id> --fail <reason>` | 写回任务失败原因（pi 插件用） |
| `vkanban -t <id> -v` | 阻塞等待任务完成 |
| `vkanban -t <id> --cancel` | 取消任务 |
| `vkanban ls [name]` | 列出任务/项目 |
| `vkanban remove <name> [--purge --cancel-running]` | 注销项目 |

> 显式不在 v0 范围：任务超时策略、守护进程、消息通知、watch/log、recover、批量任务。

---

## 二、架构总览

### 2.1 进程模型

```
用户 shell                                  pi 插件
   │                                          │
   │ vkanban -p B "..."                        │
   ▼                                          │
[ vkanban 父进程 ]                            │
   │  1. INSERT task(status=pending)           │
   │  2. CAS pending→running                   │
   │  3. spawn supervisor (Bun subprocess)     │
   │  4. detach + unref                        │
   │  5. print task_id, exit 0                 │
   │                                          │
   ▼                                          │
[ vkanban supervisor 子进程 ]                 │
   │  1. CAS running→running 自我认领          │
   │     (WHERE claimed_at IS NULL)            │
   │  2. spawn pi (detached)                   │
   │  3. await pi exit                         │
   │  4. 兜底：若 pi 未调 vkanban -t -s/--fail │
   │     → CAS running→failed(error_code=pi_exited_no_callback)
   │                                          │
   ▼                                          │
[ pi coding agent ] ─── 完成时调 ─────────────┤
              vkanban -t <id> -s "<output>"   │
              vkanban -t <id> --fail "<reason>" │
              vkanban -t <id> --cancel        │
```

### 2.2 关键不变量

1. **任务状态机由 CAS 保证原子转移**：`UPDATE ... WHERE id=? AND status=?`，通过 affected rows 判定是否成功。
2. **每个任务最多存在一个 supervisor 进程在跑**（CAS claim 排他）。
3. **pi 通过 `vkanban -t <id>` 接口写回，vkanban 是状态的唯一入口**。
4. **supervisor 是生命周期兜底**：无论 pi 是否主动写回，task 终态必然落 `done/failed`。

---

## 三、数据模型

### 3.1 文件结构

```
~/.vkanban/                       # 解析顺序: VKANBAN_HOME 环境变量 > os.homedir() + ".vkanban"
├── registry.json                  # 项目注册表: [{name, path, registered_at}, ...]
├── data.db                        # SQLite (WAL + busy_timeout=5000)
├── data.db-wal
├── data.db-shm
└── logs/                          # supervisor 子进程日志（v0 不强求写入，但预留）
```

> `VKANBAN_HOME` 解析：`os.homedir()` 为基底，可被 `VKANBAN_HOME` 覆盖。**严禁**手写 `process.env.HOME` / `USERPROFILE` 分支。

### 3.2 SQLite Schema

```sql
-- v0 可选：仅用于审计，实际注册以 registry.json 为主
CREATE TABLE IF NOT EXISTS projects (
  name          TEXT PRIMARY KEY,           -- 项目名（全局唯一，区分大小写）
  path          TEXT NOT NULL,              -- 绝对路径（native，绝对不要 POSIX 化）
  registered_at TEXT NOT NULL,              -- ISO 8601
  removed_at    TEXT                        -- 软删除时间（NULL=有效）
);

CREATE TABLE IF NOT EXISTS tasks (
  id            TEXT PRIMARY KEY,           -- nanoid(12), 字符集 [A-Za-z0-9_-]
  project_name  TEXT NOT NULL,              -- 冗余 project_name 用于 ls/project 过滤
  project_path  TEXT NOT NULL,              -- 冗余绝对路径快照（项目被 remove 后仍可读）
  content       TEXT NOT NULL,              -- ≤ 64 KiB
  output        TEXT NOT NULL DEFAULT '',   -- ≤ 1 MiB
  status        TEXT NOT NULL,              -- pending / running / done / failed / cancelled
  error_code    TEXT,                       -- 失败原因枚举，可空
  claimed_at    TEXT,                       -- supervisor CAS 自我认领时间；NULL=未认领
  created_at    TEXT NOT NULL,              -- ISO 8601
  updated_at    TEXT NOT NULL,              -- ISO 8601
  started_at    TEXT,                       -- CAS pending→running 时写入
  finished_at   TEXT,                       -- 终态时写入

  CHECK (status IN ('pending','running','done','failed','cancelled')),
  CHECK (
    error_code IS NULL OR error_code IN (
      'spawn_failed',
      'supervisor_not_claimed',
      'pi_exited_no_callback',
      'pi_failed',
      'cancelled'
    )
  ),
  CHECK (length(content) <= 64 * 1024),
  CHECK (length(output)  <= 1024 * 1024)
);

CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_status  ON tasks(status, updated_at DESC);

PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;
```

### 3.3 状态机

```
                        CAS pending→running
        ┌─────────────────────────────────────┐
        │   (父进程写入 running 触发 spawn)    │
        ▼                                     │
   ┌─────────┐    CAS pending→running    ┌─────────┐
   │ pending │ ────────────────────────► │ running │
   └─────────┘                           └─────────┘
        │                                     │
        │ 父进程写 running 失败 / spawn 失败  │  supervisor 5s 内未 CAS 自我认领
        │ → CAS pending→failed               │ → CAS running→failed
        │   error_code=spawn_failed          │   error_code=supervisor_not_claimed
        ▼                                     ▼
   ┌─────────┐                           ┌─────────┐
   │ failed  │ ◄─── 任意终态 ────         │ failed  │
   └─────────┘                           └─────────┘
                                            ▲
                       ┌────────────────────┤
                       │                    │
                  CAS running→done      CAS running→failed
                  (pi -s 写回)          (pi 失败 / --cancel)
                       │                    │
                  ┌─────────┐          ┌───────────┐
                  │  done   │          │ cancelled │
                  └─────────┘          └───────────┘
```

**error_code 语义**：

| error_code | 触发条件 | 写入时机 |
| --- | --- | --- |
| `spawn_failed` | 父进程 spawn supervisor 失败 / supervisor spawn pi 失败 | 父进程或 supervisor 兜底 |
| `supervisor_not_claimed` | 父进程 CAS 写 running 成功后，5s 内无 supervisor CAS 自我认领 | supervisor 兜底扫描 |
| `pi_exited_no_callback` | supervisor 等待 pi 退出，但 pi 没调 `vkanban -t <id> -s` | supervisor 等待结束 |
| `pi_failed` | pi 主动调 `vkanban -t <id> --fail "<reason>"` | pi 写回 |
| `cancelled` | 用户 `--cancel` 成功 CAS | 父进程 |

### 3.4 ID 生成

- 使用 `nanoid(12)`，字符集 `[A-Za-z0-9_-]`，总熵约 71.6 bit
- 避免使用 8 位 hex：在长期全局 DB 下碰撞概率不可忽略

---

## 四、命令设计

所有命令的退出码遵循 POSIX 风格：

| 退出码 | 含义 |
| --- | --- |
| 0 | 成功 |
| 1 | 用户错误（参数错、project 不存在、id 无效） |
| 2 | 数据/状态错误（状态不允许转移、CHECK 失败） |
| 3 | 环境错误（DB 损坏、HOME 不可解析、权限不足） |
| 64–78 | sysexits.h 风格（EX_USAGE 等，可选使用） |
| 124 | `-v` 阻塞超时 |

输出格式：
- `-t` 默认 JSON（机器可读）
- `ls` 表格（人类可读）
- 所有命令支持 `--json` 强制 JSON

### 4.1 `vkanban init <name> [dir]`

- 行为：
  1. 解析 `dir`：默认 `process.cwd()`，**强制转为 native absolute path**（`path.resolve`）
  2. 校验 `name`：长度 1-64，字符集 `[A-Za-z0-9_.-]`，**禁止** `..` 与 `/`
  3. 读取 `registry.json`；若已存在同名 → 退出码 1
  4. 写入 `{name, path: <abs native>, registered_at: <ISO>}` 到 `registry.json`
- 输出：`Registered project '<name>' at <path>` 或 JSON
- 退出码：0 / 1

### 4.2 `vkanban -p <name> <content...>`

- 行为：
  1. 校验 `name` 在 `registry.json` 中存在；不存在则退出码 1
  2. 解析 `<content>`：合并 `argv`（Windows argv 上限 ~32KB，故 v0 上限 28KB 保守值；超出 → 退出码 1）
  3. `INSERT INTO tasks(id, project_name, project_path, content, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)`
  4. 立即 `UPDATE tasks SET status='running', started_at=?, updated_at=? WHERE id=? AND status='pending'`，按 affected=1 判定
  5. 解析 supervisor 入口（见 §5.1）
  6. 解析 CLI 路径（见 §5.1）并注入到 supervisor 环境
  7. `Bun.spawn` 启动 supervisor，`unref()`，`detached: true`（POSIX）/ `windowsHide: true`（Windows）
  8. **父进程 5s 内轮询**（每 500ms 一次）观察 supervisor CAS 自我认领；判定标准：任务的 `claimed_at` 是否被 supervisor 写入了 ISO 时间戳（supervisor claim SQL 即 `UPDATE tasks SET claimed_at=?, updated_at=? WHERE id=? AND status='running' AND claimed_at IS NULL`，见 §5.3）。若 5s 内 `claimed_at` 仍为 `NULL` 且 `status` 仍为 `running`，CAS `running→failed` 写入 `error_code='supervisor_not_claimed'`（详见 §5.2）
  9. 打印 `task_id`，退出 0
- 退出码：0（派发成功）/ 1（参数错）/ 2（DB 状态异常）/ 3（spawn 失败）

> **不再把 content 通过 argv 传给 pi**（避免 Windows argv 32KB 限制）。supervisor 启动 pi 时**只传 `task_id`**（加 env 变量），pi 通过 `$VKANBAN_CLI -t "$VKANBAN_TASK_ID"` 或直接查 DB 取 content。

### 4.3 `vkanban -t <id>`

- 行为：查询并打印该任务的 JSON
- 输出 schema：

```json
{
  "id": "V1StGXR8_Z5j",
  "project_name": "B",
  "project_path": "C:\\proj\\B",
  "status": "done",
  "error_code": null,
  "content": "给我 xx 接口的文档",
  "output": "接口路径为 ...",
  "created_at": "2026-06-01T10:00:00Z",
  "started_at": "2026-06-01T10:00:00Z",
  "finished_at": "2026-06-01T10:00:30Z"
}
```

- 退出码：0 / 1（id 不存在）

### 4.4 `vkanban -t <id> -s <output>`

- 行为：
  1. 读出 `status`
  2. 若 `status='running'`：CAS `UPDATE ... SET status='done', output=?, finished_at=?, updated_at=? WHERE id=? AND status='running'`
     - affected=1 → 成功
     - affected=0 → 已被其他路径终结，退出码 2
  3. 若 `status` 已是终态：拒绝，退出码 2
  4. `<output>` 校验 ≤ 1 MiB（CHECK 约束）；超过 → 退出码 1
- 退出码：0 / 1 / 2

### 4.5 `vkanban -t <id> --fail <reason>`

- 行为：
  1. 读出 `status`
  2. 若 `status='running'`：CAS `UPDATE ... SET status='failed', error_code='pi_failed', output=?, finished_at=?, updated_at=? WHERE id=? AND status='running'`
     - affected=1 → 成功
     - affected=0 → 已被其他路径终结，退出码 2
  3. 若 `status` 已是终态：拒绝，退出码 2
  4. `<reason>` 校验 ≤ 1 MiB（CHECK 约束）；超过 → 退出码 1
- 退出码：0 / 1 / 2
- 与 `-s` 的区别：`-s` 写回 `done`；`--fail` 写回 `failed` + `error_code='pi_failed'`。**pi 任务失败时应直接调 `--fail`，不要先 `-s ''` 再 `--cancel`**（后者因 -s 已将 status 改为 done 而导致 --cancel CAS 失败）。

### 4.6 `vkanban -t <id> --cancel`

- 行为：CAS `running→cancelled`（`error_code='cancelled'`）
  - 仅对 `running` 有效；`done/failed/cancelled` → 退出码 2
- 退出码：0 / 1 / 2

### 4.7 `vkanban -t <id> -v`

- 行为：阻塞轮询，每 500ms 查一次，直到任务进入终态或超时
- 超时：默认 30 分钟（`VKANBAN_WAIT_TIMEOUT_MS` 可配）；超时退出码 124
- 终态时打印与 `-t` 相同的 JSON；额外在 `done` 时退出 0，`failed/cancelled` 时退出 1
- 退出码：0（done）/ 1（failed/cancelled）/ 124（timeout）

### 4.8 `vkanban ls [name]`

- 无参数：列出 registry 中所有有效项目（表格）

```
NAME        PATH                        REGISTERED          TASKS
B           C:\proj\B                   2026-06-01          12
C           /home/u/proj/C              2026-05-28          3
```

- `<name>` 参数：列出该项目的最近 50 条任务（按 `created_at` 倒序）

```
ID           STATUS      CREATED              OUTPUT (前 40 字)
V1StGXR8_Z5j done        2026-06-01 10:00     接口路径为 ...
aBcDeF123456 running     2026-06-01 09:55     ...
```

- `--json` 强制 JSON
- 退出码：0

### 4.9 `vkanban remove <name> [--purge --cancel-running]`

- 行为：
  1. 标记 `projects.removed_at = now`（软删除）—— **不删除 `registry.json` 中记录**，便于历史任务反查 `project_path`
  2. 不加 `--purge` → 退出（只注销注册）
  3. 加 `--purge`：
     - 若存在 `running` 任务：要求同时加 `--cancel-running`，否则退出码 2
     - 加 `--cancel-running`：先对每条 running 任务做 CAS → `cancelled`，**不**主动 kill pi 进程（由 pi 自身感知 cancel 或 supervisor 兜底）
     - `DELETE FROM tasks WHERE project_name = ?`
- 退出码：0 / 1 / 2

---

## 五、Supervisor 包装层

### 5.1 入口与 CLI 路径解析

**`resolveSupervisorEntrypoint()`**（位于 `src/paths.ts`）：

```ts
// 优先顺序：
// 1. 环境变量 VKANBAN_SUPERVISOR_OVERRIDE（绝对路径，开发/测试用）
// 2. 与当前模块同目录的 supervisor.<ext>：
//    - 开发态：<import.meta.dir>/supervisor.ts   (Bun 直接加载 ts，无需打包)
//    - 发布态：<import.meta.dir>/supervisor.js   (与 vkanban bin 同目录)
// 3. 找不到 → 抛错，父进程退出码 3
function resolveSupervisorEntrypoint(): string
```

**`resolveCliPath()`**（位于 `src/paths.ts`）：

```ts
// 优先顺序：
// 1. VKANBAN_CLI_OVERRIDE 环境变量（绝对路径）
// 2. process.argv[1]（vkanban 自身 binary 绝对路径）
// 3. 退回 process.execPath（Bun 二进制 + 解析主模块）—— 仅 dev 用
function resolveCliPath(): string
```

> **重要约束**：`resolveCliPath()` **只能**在 vkanban 父进程（cli.ts 主入口）内调用。supervisor 子进程**禁止**调用 `resolveCliPath()`，因为 `process.argv[1]` 在 supervisor 内是其自身入口路径。supervisor 必须**透传**父进程在 spawn 时注入的 `process.env.VKANBAN_CLI` 给 pi。

`VKANBAN_CLI` 必须解析为**绝对路径**，确保 supervisor / pi 调用 `vkanban -t <id>` 时不依赖 `PATH`。

### 5.2 Claim 流程

```
父进程 (vkanban -p)               supervisor (Bun 子进程)
  │                                  │
  │  INSERT task (status=pending,    │
  │    claimed_at=NULL)              │
  │  CAS pending→running  (A)        │
  │  spawn supervisor (unref)         │
  │  每 500ms 查一次 claimed_at      │
  │    ├─ claimed_at 已被设置        │
  │    │  → supervisor 已 claim, OK   │
  │    └─ 5s 内 claimed_at 仍 NULL   │
  │         + status 仍 running      │
  │       → CAS running→failed       │
  │         error_code=supervisor_not_claimed
  │                                  │
  │                                  │  CAS running→running (B) 自我认领
  │                                  │    SET claimed_at=now
  │                                  │    WHERE id=? AND status='running'
  │                                  │      AND claimed_at IS NULL
  │                                  │  if (B changes!=1) exit 0
  │                                  │    // 任务已被父进程兜底 OR
  │                                  │    // 已有其他 supervisor 认领
```

> **排他性保证**：claim SQL 必须包含 `claimed_at IS NULL` 谓词。`running→running` 简单 CAS 无法阻止多 supervisor 抢同一任务（每个 supervisor 的 `updated_at` UPDATE 都会 `changes=1`）。`claimed_at` 一旦被任一 supervisor 写入，其它 supervisor 的 CAS 因 IS NULL 谓词不满足而 changes=0。

- **claim timeout**：默认 5000ms；环境变量 `VKANBAN_CLAIM_TIMEOUT_MS` 覆盖
- 慢机器/冷启动允许的 grace period 由该变量控制；不得硬编码 1s
- 父进程在 spawn supervisor 后**不能立即 exit 0**而不做兜底：必须阻塞到 5s 监控结束（或采用"spawn + 立即返回 + 后台 doctor 扫描"v1 改进）

### 5.3 Spawn pi + 等待

```ts
// supervisor 主流程伪代码（src/supervisor.ts）
import { Database } from "bun:sqlite";
import { killProcessTree } from "./kill.ts";
// 注意: 不要 import resolveCliPath()。supervisor 必须透传父进程
//       注入的 process.env.VKANBAN_CLI（见 §5.1 约束）。

async function main() {
  const taskId = process.env.VKANBAN_TASK_ID!;
  const dbPath = process.env.VKANBAN_DB!;
  const piCmd  = process.env.VKANBAN_PI_CMD || "pi";
  const projectPath = process.env.VKANBAN_PROJECT_PATH!;
  // 注: 父进程侧的 5s claim 监控由 §4.2 处理；supervisor 自身不设超时，
  //     启动后立即做一次 CAS 自我认领，失败即 exit 0（任务已被父进程兜底）。
  //     VKANBAN_CLAIM_TIMEOUT_MS 仅父进程侧使用。

  const db = new Database(dbPath);

  // 1. claim（CAS 排他：必须 claimed_at IS NULL）
  const now = new Date().toISOString();
  const claimed = db
    .query(`UPDATE tasks SET claimed_at=?, updated_at=?
            WHERE id=? AND status='running' AND claimed_at IS NULL`)
    .run(now, now, taskId);
  if (claimed.changes !== 1) {
    // 父进程已兜底标 failed，或其他 supervisor 已认领
    process.exit(0);
  }

  // 2. spawn pi（**只传 task_id，content 让 pi 自己查 DB**）
  let pi;
  try {
    pi = Bun.spawn([piCmd, "--vkanban", taskId], {
      cwd: projectPath,                // native absolute path
      env: {
        ...process.env,
        VKANBAN_TASK_ID: taskId,
        // 透传父进程注入的 VKANBAN_CLI；不要在此处调用 resolveCliPath()
        // （supervisor 进程内 argv[1] 是 supervisor 自身入口，解析会出错）
        VKANBAN_CLI: process.env.VKANBAN_CLI!,
        VKANBAN_HOME: process.env.VKANBAN_HOME!,
        VKANBAN_DB: dbPath,
      },
      detached: process.platform !== "win32",
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch (e) {
    // spawn 失败兜底
    db
      .query(`UPDATE tasks SET status='failed', error_code='spawn_failed',
              output=?, finished_at=?, updated_at=?
              WHERE id=? AND status='running'`)
      .run(String(e), new Date().toISOString(), new Date().toISOString(), taskId);
    process.exit(1);
  }

  // 3. 等待 pi 退出
  const exitCode = await pi.exited;

  // 4. 检查 task 终态：若 pi 仍未调 -s/-cancel 写回，兜底
  const row = db
    .query(`SELECT status FROM tasks WHERE id=?`)
    .get(taskId) as { status: string };

  if (row.status === "running") {
    // pi 退出但未写回 → 兜底标 failed
    const msg = `pi exited (code=${exitCode}) without writing back. ` +
                `Use: vkanban -t ${taskId} -s "<output>"`;
    db
      .query(`UPDATE tasks SET status='failed', error_code='pi_exited_no_callback',
              output=?, finished_at=?, updated_at=?
              WHERE id=? AND status='running'`)
      .run(msg, new Date().toISOString(), new Date().toISOString(), taskId);
  }
  // 终态已由 -s/-cancel 写入：no-op
  process.exit(0);
}
```

### 5.4 与 -s / --cancel 的交互

- 父进程 spawn supervisor 后退出 0；supervisor 负责持有 pi 进程组
- 用户 `vkanban -t <id> --cancel`：CAS `running→cancelled`，**不主动 kill**（pi 可能自己感知 DB 状态变化）
- 用户 `vkanban -t <id> -s ...`：CAS `running→done`，**不主动 kill**（让 pi 自然完成）
- supervisor 在 pi 退出后做"running 兜底"——这是**状态终态保证**的关键

---

## 六、Pi 写回契约

pi 扩展必须**自己**负责调 `vkanban -t <id> -s "<output>"` 或 `--fail "<reason>"`。vkanban 提供以下环境变量给 pi ：

| 变量 | 含义 |
| --- | --- |
| `VKANBAN_TASK_ID` | 任务 ID |
| `VKANBAN_HOME` | vkanban 数据目录（registry + db） |
| `VKANBAN_DB` | SQLite db 绝对路径（`$VKANBAN_HOME/data.db`） |
| `VKANBAN_CLI` | `vkanban` 可执行文件绝对路径 |
| `VKANBAN_PROJECT_PATH` | 任务所属项目目录（native absolute） |

pi 端实现要点（不在 vkanban 范围）：
- 任务开始时可读 DB 拿 `content`（vkanban 提供 `vkanban -t <id>` JSON 输出）
- 任务成功完成时调 `$VKANBAN_CLI -t $VKANBAN_TASK_ID -s "$output"`
- 任务失败时调 `$VKANBAN_CLI -t $VKANBAN_TASK_ID --fail "<reason>"`（**不要**先调 `-s ""` 再调 `--cancel`，后者因状态已变 done 而 CAS 失败）
- pi 启动参数：`pi --vkanban <task_id>`（由 vkanban supervisor 调用），进入"vkanban 模式"

---

## 七、跨平台实现要点

### 7.1 Kill 进程树

封装 `src/kill.ts`，统一使用 `tree-kill` npm 包：

```ts
import treeKill from "tree-kill";
export function killProcessTree(pid: number, signal = "SIGTERM"): Promise<void> {
  return new Promise((res) => treeKill(pid, signal, () => res()));
}
```

- Linux/macOS：spawn `detached: true` 后用 `process.kill(-pid, signal)`（进程组）—— 已被 `tree-kill` 覆盖
- Windows：不要用 `process.kill(pid, 'SIGTERM')`；`tree-kill` 内部走 `taskkill /T /F /PID` 等价物
- v0 在 supervisor 流程中**不主动调用**（见 §5.4），但保留封装以便未来 cancel-with-kill

### 7.2 路径处理

- **所有 cwd / 命令参数 / DB 路径 / env 路径一律用 native absolute path**（`path.resolve` + `path.isAbsolute` 校验）
- 严禁把 Windows 路径转 POSIX 风格
- 展示层（`ls` 表格）可保持 native 风格，JSON 输出也保持 native

### 7.3 Detach

- POSIX：`detached: true` + `unref()`（子进程成为新 session leader）
- Windows：`detached: false`（job object 由 Bun 管理） + `windowsHide: true`；不依赖 POSIX detach 语义
- v0 不做 `start /B` 或 `nohup` shell 包装

---

## 八、错误码与退出码汇总

| 场景 | 退出码 | error_code |
| --- | --- | --- |
| 成功 | 0 | - |
| 参数错（id 格式、name 字符集、长度超限） | 1 | - |
| 状态不允许转移（对 done 任务 -s） | 2 | - |
| DB 错误（损坏、连接失败） | 3 | - |
| spawn 失败（supervisor / pi） | 3 | `spawn_failed` |
| 父进程兜底：5s 内无 supervisor claim | 0（vkanban 仍成功派发） | `supervisor_not_claimed` |
| supervisor 兜底：pi 退出未写回 | （supervisor exit 1） | `pi_exited_no_callback` |
| pi 报告失败 | 0（--fail 成功） | `pi_failed` |
| `-v` 超时 | 124 | - |

---

## 九、目录结构（项目代码）

```
vkanban/
├── package.json
├── tsconfig.json
├── README.md
├── docs/
│   └── superpowers/
│       └── specs/
│           └── 2026-06-01-vkanban-design.md
├── src/
│   ├── cli.ts              # 命令分发
│   ├── paths.ts            # VKANBAN_HOME / supervisor / CLI 路径解析
│   ├── db.ts               # bun:sqlite 单例 + schema 初始化 + PRAGMA
│   ├── registry.ts         # registry.json CRUD
│   ├── tasks.ts            # tasks 表 CAS 操作
│   ├── kill.ts             # tree-kill 封装
│   ├── supervisor.ts       # Bun 子进程入口
│   └── commands/
│       ├── init.ts
│       ├── dispatch.ts     # -p
│       ├── query.ts        # -t
│       ├── writeback.ts    # -s
│       ├── fail.ts         # --fail
│       ├── cancel.ts       # --cancel
│       ├── wait.ts         # -v
│       ├── list.ts         # ls
│       └── remove.ts
└── tests/
    ├── unit/
    │   ├── paths.test.ts
    │   ├── registry.test.ts
    │   ├── tasks.test.ts
    │   └── kill.test.ts
    └── e2e/
        ├── happy_path.test.ts
        ├── pi_crash.test.ts
        ├── supervisor_not_claimed.test.ts
        ├── cancel.test.ts
        └── remove_purge.test.ts
```

---

## 十、风险与未来工作（v1+）

| 风险 | 缓解 | 升级路径 |
| --- | --- | --- |
| supervisor 入口解析在开发/发布态路径分歧 | `resolveSupervisorEntrypoint()` 集中处理 | v1 打包成单一 binary |
| `VKANBAN_CLI` 在 link/symlink 场景失效 | `resolveCliPath()` 优先 `process.argv[1]`，加 `VKANBAN_CLI_OVERRIDE` | v1 打包后 argv[1] 稳定 |
| 5s claim timeout 在冷启动机器误判 | `VKANBAN_CLAIM_TIMEOUT_MS` 可调 | v1 加入 `vkanban doctor` 扫描 stale pending/running |
| `registry.json` 无并发锁 | v0 接受（人工不并发 init） | v1 用 SQLite `projects` 表替代 |
| `-v` 30min 默认超时硬编码 | `VKANBAN_WAIT_TIMEOUT_MS` | v1 改为长连接 + 推送 |
| `pi` 扩展不实现时所有任务都进 `pi_exited_no_callback` | supervisor 兜底 | 持续文档化 |
| Windows 进程组语义差异 | `tree-kill` 统一封装 | 持续 smoke test |
| 大量历史任务累积 DB 膨胀 | v0 不处理 | v1 加 TTL + `vkanban gc` |
| 任务内容含敏感信息落库 | v0 不处理 | v1 加 `vkanban seal`（加密）/ 自动 redact |

---

## 十一、变更记录

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| v0.1 | 2026-06-01 | 初稿：头脑风暴产出 |
| v0.2 | 2026-06-01 | Oracle 第一轮审查整改：supervisor 包装、退出码、CAS、env 契约、tree-kill、原生路径、purge 约束、CHECK 约束、bun:sqlite、nanoid、JSON 输出、homedir |
| v0.3 | 2026-06-01 | Oracle 第二轮审查整改：supervisor 入口解析、claim timeout 5s + 可配、VKANBAN_CLI 解析、error_code 字段与 CHECK 枚举、content 不通过 argv 传 pi、supervisor spawn try/catch |
| v0.4 | 2026-06-01 | Oracle v0.3 复查整改：supervisor 入口改 `<import.meta.dir>/supervisor.ts` 同级解析、supervisor 禁止调用 resolveCliPath 改透传 VKANBAN_CLI env、tasks 加 `claimed_at` 字段实现 claim 排他、新增 `--fail <reason>` 命令入口解决 pi_failed 语义矛盾 |
