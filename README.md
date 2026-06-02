# vkanban

基于pi coding agent构建的极简跨项目任务看板，用于跨项目协调和编排。

## 安装

```bash
bun install
```

## 快速开始

```bash
# 注册项目
vkanban init my_project /path/to/project

# 启动 daemon（另开终端或安装为 Windows 服务）
vkanban daemon

# 发布任务：只入队并立即返回 task_id
vkanban -p my_project "帮我检查一下 xxx"

# 查询任务进度
vkanban -t <task_id>

# 查看所有项目
vkanban ls

# 查看项目的所有任务
vkanban ls my_project
```

## 命令列表

| 命令 | 说明 |
| --- | --- |
| `vkanban init <name> [dir]` | 注册项目目录 |
| `vkanban -p <name> <content>` | 派发任务到项目 |
| `vkanban -t <id>` | 查询任务状态 |
| `vkanban -t <id> -s <output>` | 写回任务完成 (pi 调用) |
| `vkanban -t <id> --fail <reason>` | 写回任务失败 (pi 调用) |
| `vkanban -t <id> --cancel` | 取消任务 |
| `vkanban -t <id> -v` | 阻塞等待任务完成 |
| `vkanban ls [name]` | 列出项目 / 任务 |
| `vkanban remove <name> [--purge --cancel-running]` | 注销项目 |
| `vkanban daemon [--once] [--poll-interval-ms <ms>]` | 运行任务执行 daemon |
| `vkanban service install\|uninstall\|start\|stop\|status` | Windows Service 管理 daemon |

## 数据目录

- `VKANBAN_HOME` 环境变量 (默认 `~/.vkanban/`)
- `registry.json` — 项目注册表
- `data.db` — 任务库 (SQLite, WAL mode)

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `VKANBAN_HOME` | 数据目录路径 (默认 ~/.vkanban) |
| `VKANBAN_DAEMON_POLL_INTERVAL_MS` | daemon 空闲轮询间隔 (默认 1000ms) |
| `VKANBAN_CLAIM_TIMEOUT_MS` | **legacy**：dispatch 不再等待 claim |
| `VKANBAN_SUPERVISOR_OVERRIDE` | **legacy**：dispatch 不再启动 supervisor |
| `VKANBAN_WAIT_TIMEOUT_MS` | `-v` 等待超时 (默认 30min) |
| `VKANBAN_CLI_OVERRIDE` | 覆盖 CLI 路径解析 |
| `VKANBAN_PI_CMD` | pi 命令行 (默认 "pi") |

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

**注意**：daemon 被终止（`Ctrl+C` / `sc.exe stop`）时，正在执行的任务会留在 `running` 状态。可用以下命令手动清理：

```bash
vkanban -t <task_id> --fail "daemon stopped"
```

后续版本将实现信号处理，在退出前自动标记当前任务为 failed。

## 许可证

MIT
