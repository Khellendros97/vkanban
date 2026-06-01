# AGENTS.md — vkanban

Cross-project task dispatch and tracking CLI. TypeScript, **Bun runtime only** (not Node.js).

## Quick commands

```bash
bun install              # install deps
bun test                 # all tests (unit + e2e)
bun test tests/unit      # unit only
bun test tests/e2e       # e2e only
bun run src/cli.ts ...   # run CLI directly (no build step needed)
```

## Architecture

```
src/cli.ts             # Entry point: rewrites user-facing flags to Commander subcommands
  └─ rewriteArgv()     # Maps -p/-t/-s/ls/-v/--fail/--cancel to dispatch/query/writeback/wait/...
src/commands/*.ts      # Commander subcommands (init, dispatch, query, writeback, fail, cancel, wait, list, remove)
src/tasks.ts           # SQLite task CRUD + CAS state transitions (pending→running→done/failed/cancelled)
src/registry.ts        # Project registry (JSON file at VKANBAN_HOME/registry.json)
src/db.ts              # SQLite init (WAL mode), schema, getDb()
src/paths.ts           # Path resolution (VKANBAN_HOME, supervisor entry, CLI path)
src/supervisor.ts      # Separate process: claims task → spawns pi → awaits exit → fallback writeback
src/kill.ts            # tree-kill wrapper (reserved for future cancel-with-kill)
```

**State machine:** `pending` → `running` → `done` | `failed` | `cancelled`. All transitions use CAS (compare-and-swap) — never raw UPDATE.

**Data flow for dispatch:** `cli.ts` → `dispatch.ts` inserts task in SQLite, transitions to `running`, spawns supervisor process → `supervisor.ts` CAS-claims task, spawns `pi`, waits for pi to callback via `-t -s`/`--fail`.

## Critical gotchas

### Runtime
- This is **Bun** — use `bun run`, `bun test`, `Bun.spawn`, `Bun.env`, `bun:sqlite`. Do NOT use `node:child_process`, `process.env` (use `Bun.env` for consistency), or `better-sqlite3`.

### CLI flag rewriting
- `src/cli.ts` has a `rewriteArgv()` preprocessor that converts user-facing syntax to internal subcommands. If you add a new top-level flag, you must add it here.
- `-p <name> <content>` → `dispatch -p <name> <content>`
- `-t <id>` → `query -t <id>`
- `-t <id> -s <output>` → `writeback -t <id> -s <output>`
- `-t <id> -v` → `wait -t <id>`
- `ls` → `list`

### Output format
- All output is **JSON** (both stdout and stderr).
- Normal results go to stdout, errors go to stderr.
- Exit codes: 0 = success, non-zero = error (specific codes vary by command).

### SQLite & database
- DB lives at `VKANBAN_HOME/data.db` with WAL mode and `busy_timeout=5000`.
- Table has CHECK constraints (content ≤ 65536, output ≤ 1048576, valid status/enum values). Invalid inserts will throw.
- `initDb()` and `initRegistry()` are called automatically at CLI startup. In tests you must set `Bun.env.VKANBAN_HOME` **before** calling these.

### Testing
- Tests use Bun's native test runner (`bun:test`).
- **Always** set `Bun.env.VKANBAN_HOME` to a unique temp dir before `initDb()`/`initRegistry()`.
- **Always** call `closeDb()` in `afterAll` before deleting temp dirs (SQLite holds file locks).
- E2E tests spawn CLI via `bun run $CLI` using Bun's `$` shell.
- Unit tests import and call source modules directly (no process spawn).

### Supervisor
- The supervisor is spawned as a **separate Bun process**: `Bun.spawn([process.execPath, "run", supervisorEntry], ...)`.
- It CAS-claims the task (`claimed_at IS NULL`) to ensure exactly-once execution.
- If pi exits without calling `-s`/`--fail`, the supervisor writes a fallback `pi_exited_no_callback` failure.

### Environment variables
- `VKANBAN_HOME` — data dir (default `~/.vkanban`)
- `VKANBAN_CLAIM_TIMEOUT_MS` — supervisor claim timeout (default 5000)
- `VKANBAN_WAIT_TIMEOUT_MS` — `-v` wait timeout (default 30min)
- `VKANBAN_CLI_OVERRIDE` / `VKANBAN_SUPERVISOR_OVERRIDE` — path overrides for development
- `VKANBAN_PI_CMD` — pi binary (default `pi`)
