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

# 发布任务
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

## 数据目录

- `VKANBAN_HOME` 环境变量 (默认 `~/.vkanban/`)
- `registry.json` — 项目注册表
- `data.db` — 任务库 (SQLite, WAL mode)

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `VKANBAN_HOME` | 数据目录路径 (默认 ~/.vkanban) |
| `VKANBAN_CLAIM_TIMEOUT_MS` | supervisor claim 超时 (默认 5000ms) |
| `VKANBAN_WAIT_TIMEOUT_MS` | `-v` 等待超时 (默认 30min) |
| `VKANBAN_CLI_OVERRIDE` | 覆盖 CLI 路径解析 |
| `VKANBAN_SUPERVISOR_OVERRIDE` | 覆盖 supervisor 入口路径 |
| `VKANBAN_PI_CMD` | pi 命令行 (默认 "pi") |

## 许可证

MIT
