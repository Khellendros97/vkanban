# Hermes Kanban 架构全览

> 基于 Hermes Agent v0.11.0 源码分析
> 源文件路径：`/root/.hermes/hermes-agent/`，代码量约 7,386 行（kanban_db.py）+ 2,828 行（kanban.py）

---

## 一、核心理念

Hermes Kanban 是一套 **多 Profile（角色/Agent）协作的任务编排与调度系统**。它的设计要回答一个核心问题：

> 一个系统里有多个 AI Agent（每个一个 Profile），各有专长，如何让它们协同完成复杂任务？

### 设计目标
- **Profile 间协调**：不同 Profile 共享同一个看板，而非各管各的
- **任务生命周期**：triage → todo → ready → running → done / blocked / review
- **有向无环图依赖**：父任务完成后，子任务自动变为可调度
- **自动调度派发**：Dispatcher 自动将 ready 任务分配给对应 Profile 的 worker 进程
- **失败重试与熔断**：连续失败超出阈值自动阻塞，不浪费 token
- **多看板隔离**：一个项目一块板，互不干扰

---

## 二、架构分层

```
┌─────────────────────────────────────────────────┐
│                CLI / Slash Command               │  hermes kanban create/show/complete ...
│              kanban.py (2,828 行)                 │
├─────────────────────────────────────────────────┤
│              Agent Tool 层                        │
│           tools/kanban_tools.py (1,381 行)        │  对 LLM 暴露的工具接口
├─────────────────────────────────────────────────┤
│              Dispatcher 调度器                    │
│   gateway/run.py (embedded) / kanban_daemon      │  定期轮询 DB，自动派发
├─────────────────────────────────────────────────┤
│              看板数据库层                          │
│         hermes_cli/kanban_db.py (7,386 行)        │  核心：SQLite 操作
├─────────────────────────────────────────────────┤
│   Decompose     Specify      Swarm     Diagnostics│
│   (16,350)      (8,931)      (9,261)    (41,957) │  高级功能模块
└─────────────────────────────────────────────────┘
```

### 各层职责

#### 1. 数据库层 —— `kanban_db.py`
最厚的层，约 7,386 行。包含：
- SQLite Schema（5 张核心表）
- CRUD（create_task, get_task, list_tasks, complete_task, delete_task ...）
- 状态机（claim_task, release_stale_claims, recompute_ready, block_task ...）
- 工作区管理（resolve_workspace, scratch workspace 创建）
- Worker 进程管理（_default_spawn, spawn 子进程）
- 自动调度核心（dispatch_once）
- Worker 上下文拼接（build_worker_context）
- 多看板路由（board slug 解析链）

#### 2. CLI 层 —— `kanban.py`
提供 `hermes kanban <subcommand>` 的 argparse 接口 + 格式化输出。
子命令包括：create, list, show, complete, block, comment, log, tail, boards, specify, decompose, swarm, daemon, promote 等。

#### 3. Tool 层 —— `tools/kanban_tools.py`
对 LLM 暴露的工具接口。包含面向 Agent 的工具函数：
- `kanban_show()` —— 查看任务详情（含 parent handoff、评论、运行历史）
- `kanban_create()` —— 创建新任务
- `kanban_complete()` —— 完成当前任务并结构化交接
- `kanban_block()` —— 阻塞任务等待外部输入
- `kanban_comment()` —— 追加评论
- `kanban_heartbeat()` —— 心跳保活
- `kanban_list()` —— 列表任务（orchestrator only）
- `kanban_link()` —— 添加父子依赖

**工具与 CLI 的关系**：功能等价，但工具通过结构化 JSON 参数传递，不走 shell 管道，不与 SSH/Docker 终端后端冲突。

#### 4. Dispatcher 调度层
- 默认内嵌在 Gateway 中（`gateway/run.py`）
- 每 60 秒执行一次 `dispatch_once()`（可配置）
- 也可单独启动：`hermes kanban daemon`

---

## 三、数据库设计（SQLite）

### Schema（5 张核心表）

#### `tasks` —— 任务主表
```sql
CREATE TABLE tasks (
    id                   TEXT PRIMARY KEY,          -- URL-safe 短 ID（如 t_a6acd07d）
    title                TEXT NOT NULL,
    body                 TEXT,                      -- 任务描述 / Spec
    assignee             TEXT,                      -- 分配给哪个 Profile
    status               TEXT NOT NULL,             -- triage|todo|ready|running|blocked|review|done|archived
    priority             INTEGER DEFAULT 0,
    created_by           TEXT,
    created_at           INTEGER NOT NULL,
    started_at           INTEGER,
    completed_at         INTEGER,
    workspace_kind       TEXT NOT NULL DEFAULT 'scratch',  -- scratch|worktree|dir
    workspace_path       TEXT,
    branch_name          TEXT,
    claim_lock           TEXT,                      -- 谁锁定了这个任务
    claim_expires        INTEGER,                   -- 锁定过期时间
    tenant               TEXT,                      -- 租户 / 命名空间
    result               TEXT,                      -- 完成任务时的结果摘要
    idempotency_key      TEXT,                      -- 幂等键（防止重复创建）
    consecutive_failures INTEGER NOT NULL DEFAULT 0,-- 连续失败次数（熔断用）
    worker_pid           INTEGER,                   -- 当前 worker 的进程 ID
    last_failure_error   TEXT,
    max_runtime_seconds  INTEGER,                   -- 最大运行时间
    last_heartbeat_at    INTEGER,                   -- 最后心跳时间
    current_run_id       INTEGER,                   -- 当前运行 ID
    workflow_template_id TEXT,                      -- 工作流模板（v2 预留）
    current_step_key     TEXT,
    skills               TEXT,                      -- JSON 数组：强制加载的技能
    model_override       TEXT,                      -- 模型覆盖
    max_retries          INTEGER,                   -- 每任务重试次数
    session_id           TEXT                       -- 来源会话 ID
);
```

#### `task_links` —— 任务依赖（DAG）
```sql
CREATE TABLE task_links (
    parent_id  TEXT NOT NULL,
    child_id   TEXT NOT NULL,
    PRIMARY KEY (parent_id, child_id)
);
```

#### `task_comments` —— 评论 / 黑板
```sql
CREATE TABLE task_comments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    TEXT NOT NULL,
    author     TEXT NOT NULL,
    body       TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
```
Swarm 模式用它做"黑板"（blackboard）：Worker 通过结构化 JSON 评论交换信息。

#### `task_events` —— 事件日志
```sql
CREATE TABLE task_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    TEXT NOT NULL,
    run_id     INTEGER,
    kind       TEXT NOT NULL,        -- claimed|completed|blocked|promoted|...
    payload    TEXT,                 -- JSON payload
    created_at INTEGER NOT NULL
);
```
事件驱动了通知系统（Notifier）。

#### `task_runs` —— 运行记录（每次调度一条）
```sql
CREATE TABLE task_runs (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id             TEXT NOT NULL,
    profile             TEXT,
    step_key            TEXT,
    status              TEXT NOT NULL,   -- running|done|blocked|crashed|timed_out|failed|released
    claim_lock          TEXT,
    claim_expires       INTEGER,
    worker_pid          INTEGER,
    max_runtime_seconds INTEGER,
    summary             TEXT,            -- Worker 完成时的摘要
    error               TEXT,
    metadata            TEXT,            -- 结构化元数据（JSON）
    started_at          INTEGER,
    ended_at            INTEGER
);
```

---

## 四、任务生命周期

```
  triage ──decompose/specify──► todo
                                  │
                                  ▼
                               ready  ◄── recompute_ready (parent 完成后)
                                  │
                                  ▼
                              running ◄── claim_task（CAS 原子锁定）
                               │   │
                     ┌─────────┘   └─────────┐
                     ▼                        ▼
                   done                    blocked
                     │                        │
                     ├──► review ──► running──► done
                     │
                     ▼
                 archived
```

### 状态说明
| 状态 | 含义 |
|------|------|
| `triage` | 粗放的想法，待分解为具体任务 |
| `todo` | 已评估但依赖未就绪（有未完成的 parent） |
| `scheduled` | 已排期（未来某时间执行） |
| `ready` | 可调度（所有 parent 已完成，等待 Dispatcher 认领） |
| `running` | 正在执行中（Worker 已 spawn） |
| `blocked` | 受阻，等待外部输入 |
| `review` | 需要 Review（如 Code Review） |
| `done` | 完成 |
| `archived` | 归档 |

### 状态转移核心逻辑 (`claim_task`)
使用 **CAS（Compare-And-Swap）** 模式防止并发争抢：
```sql
UPDATE tasks
   SET status = 'running', claim_lock = ?, claim_expires = ?
 WHERE id = ?
   AND status = 'ready'        -- 只有 ready 才能被抢
   AND claim_lock IS NULL       -- 没人锁着
```
只影响一行则成功，0 行则失败（已被人抢走）。

---

## 五、Dispatcher 调度机制

### 调度入口：`dispatch_once()`

每 tick 执行以下步骤：

```
1. reap_worker_zombies()         —— 收割僵尸进程
2. release_stale_claims()        —— 回收 TTL 过期的 task
3. detect_stale_running()        —— 检测心跳超时的 task
4. detect_crashed_workers()      —— 检测进程已死的 worker
5. enforce_max_runtime()         —— 超时未完成的 task
6. recompute_ready()             —— parent 完成 → child 自动变为 ready
7. 遍历 ready 任务：
   a. 跳过无 assignee 的任务
   b. 跳过不存在的 profile
   c. 检查 per-profile 并发上限
   d. 检查 respawn guard（熔断保护）
   e. claim_task()——CAS 锁定
   f. resolve_workspace()——分配工作目录
   g. _default_spawn()——fork 子进程
```

### Worker 进程生成：`_default_spawn()`

Worker 实际是一个独立的 Hermes CLI 子进程：

```python
cmd = [
    "hermes", "-p", profile_arg,   # 使用任务分配的 Profile
    "--accept-hooks",
    "--skills", "kanban-worker",    # 加载 kanban-worker 技能
    "chat", "-q", "work kanban task <ID>"
]

# 子进程继承看板环境变量
env["HERMES_KANBAN_TASK"] = task.id     # 告诉 Worker 它在执行哪个任务
env["HERMES_KANBAN_DB"]   = <DB path>   # 告诉 Worker 看板 DB 路径
env["HERMES_KANBAN_WORKSPACE"] = <dir>  # 告诉 Worker 工作区路径
env["HERMES_PROFILE"]   = profile_arg   # 告诉 Worker 它的 Profile
```

子进程的 stdout/stderr 重定向到 `<board-root>/logs/<task_id>.log`。

### 并发控制
- `max_spawn`：全看板最大并发数
- `max_in_progress`：正在运行中的任务上限
- `max_in_progress_per_profile`：每个 profile 的并发上限
- `failure_limit`：连续失败熔断阈值（默认 3）
- `max_runtime_seconds`：每任务执行时间上限

---

## 六、多看板架构（Multi-Board）

### 看板 == 项目（独立 DB）

```
~/.hermes/
├── kanban.db                     ← default 看板（后向兼容）
├── kanban/
│   ├── current                   ← 当前活跃看板 slug
│   ├── boards/
│   │   ├── project-a/
│   │   │   ├── kanban.db         ← 独立数据库
│   │   │   ├── workspaces/       ← 工作目录
│   │   │   └── logs/             ← 日志
│   │   └── project-b/
│   │       └── ...
│   ├── workspaces/               ← default 看板的工作区
│   └── logs/                     ← default 看板的日志
```

### 看板解析链（高优先级优先）
1. 参数 `board=` —— 显式指定
2. 环境变量 `HERMES_KANBAN_BOARD` —— Dispatcher 注入给 Worker
3. 文件 `~/.hermes/kanban/current` —— `hermes kanban boards switch <slug>` 写入
4. 默认值 `"default"`

---

## 七、任务分解机制（Decompose）

`kanban_decompose.py` 使用**辅助模型**将 triage 任务自动分解为有依赖关系的子任务。

流程：
1. 读取所有可用 Profile 的名单 + 描述
2. 构建系统提示（告诉 LLM 按 Profile 专长派发任务）
3. LLM 返回 JSON 格式的任务图（含依赖关系）
4. 解析后创建子任务并建立 task_links 依赖
5. 根任务保持为抽象任务（orchestrator 所有权），叶子任务具体分配

返回格式示例：
```json
{
  "fanout": true,
  "rationale": "需要独立调研文档、编写接口、测试验证",
  "tasks": [
    {"title": "调研xx接口文档", "body": "...", "assignee": "researcher-a", "parents": []},
    {"title": "实现xx接口", "body": "...", "assignee": "coder-b", "parents": [0]},
    {"title": "编写测试用例", "body": "...", "assignee": "tester-c", "parents": [0, 1]}
  ]
}
```

---

## 八、Swarm 模式（分布式并行）

`kanban_swarm.py` 在 Kanban 之上构建了一个**规划-执行-验证-合成**的四层工作流：

```
规划根（immediately done）
   ├── 专家 A（并行, ready）
   ├── 专家 B（并行, ready）
   └── 专家 C（并行, ready）
        ↓
    验证者（待所有专家完成, todo）
        ↓
    合成者（待验证者完成, todo）
```

Shared Blackboard：所有间件信息通过根任务的**结构化 JSON 评论**交换——没有额外服务，复用 task_comments 表。

---

## 九、通知系统（Notifier）

在 Gateway 中以 5 秒间隔轮询 `kanban_notify_subs` 表，当订阅的任务发生事件（done, blocked, comment）时：
1. 通过平台适配器（Telegram/Discord/DingTalk）发送通知
2. 自动上传 Worker 产出的 artifact 文件（图片、PDF 等）

---

## 十、关键环境变量

| 环境变量 | 用途 |
|----------|------|
| `HERMES_KANBAN_TASK` | 当前 Worker 被分配的任务 ID |
| `HERMES_KANBAN_RUN_ID` | 当前运行记录 ID |
| `HERMES_KANBAN_CLAIM_LOCK` | 锁定标记（用于 CAS 争抢） |
| `HERMES_KANBAN_DB` | 看板数据库路径 |
| `HERMES_KANBAN_BOARD` | 当前看板 slug |
| `HERMES_KANBAN_WORKSPACE` | 工作区路径 |
| `HERMES_KANBAN_WORKSPACES_ROOT` | 工作区根目录 |
| `HERMES_KANBAN_CLAIM_TTL_SECONDS` | 锁定 TTL（默认 15 min） |
| `HERMES_KANBAN_HOME` | Kanban 根目录（覆盖默认路径） |
| `HERMES_TENANT` | 租户/命名空间 |

---

## 十一、对你的 vkanban 工具的启示

以下是老臣的几点建议：

### 核心差异定位
| Hermes Kanban | vkanban |
|---|---|
| 一个中心看板 + 多个 Profile | 一个命令调起特定项目的 Agent |
| 自动调度（Dispatcher 定时轮询） | 即发即用（用户给指令，Agent 马上执行）|
| 看板持久化 | 可能不需要看板，只需消息路由 |
| DAG 依赖、失败重试 | 一对一问答模式 |

### 建议架构

```
vkanban -p project_b "给我xx接口的文档"
  │
  ├─ 1. 解析参數 → 找到 project_b 的配置
  │     （项目配置：Project Root, Starting Prompt, Skills）
  │
  ├─ 2. 加载项目专用的 System Prompt
  │     （如：你是 project_b 的工程师，项目根目录在 /path/to/b）
  │
  ├─ 3. 在当前会话中切换到该 Prompt 上下文
  │     （或 Fork 一个子 Agent 进程）
  │
  └─ 4. 回答问题，返回结果
```

### 可以借鉴 Hermes 的点
1. **环境变量传递上下文**：Worker 进程通过 env 拿任务配置（vs 命令行参数传递）
2. **Profile 系统**：按项目定义不同的角色，每个角色有独立的 SysPrompt、Skills
3. **多看板**：一个项目一块板，用 slug 区分
4. **工作区管理**：scratch 模式 vs 已有项目目录
5. **Tool 接口模式**：结构化参数比 shell 管道安全

老臣建议主人将 vkanban 设计为一个**轻量级 CLI 封装**——核心逻辑是：`"查找项目配置 → 注入 System Prompt + 工作目录 → 调用 Agent → 返回结果"`，无需看板持久化层，也就无需复杂的 DAG、熔断、Dispatcher。

若主人愿意，老臣可以就此架构进一步设计实现方案。
