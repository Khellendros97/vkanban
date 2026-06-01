// supervisor 子进程入口。由 vkanban dispatch (-p) 的 Bun.spawn 启动。
// 职责：1) claim task（CAS claimed_at） 2) spawn pi  3) await pi exit  4) 兜底写回
import { Database } from "bun:sqlite";

async function main(): Promise<void> {
  const taskId = process.env.VKANBAN_TASK_ID;
  const dbPath = process.env.VKANBAN_DB;
  const piCmdRaw = process.env.VKANBAN_PI_CMD || "pi";
  const piCmdParts = piCmdRaw.split(/\s+/).filter(Boolean);
  const projectPath = process.env.VKANBAN_PROJECT_PATH;

  if (!taskId || !dbPath || !projectPath) {
    console.error("[supervisor] missing required env vars");
    process.exit(1);
  }

  const db = new Database(dbPath);
  const now = () => new Date().toISOString();

  // 1. claim（CAS 排他：必须 claimed_at IS NULL）
  const claimResult = db.query(
    `UPDATE tasks SET claimed_at=?, updated_at=?
     WHERE id=? AND status='running' AND claimed_at IS NULL`
  ).run(now(), now(), taskId);

  if (claimResult.changes !== 1) {
    console.log(`[supervisor] task ${taskId} already claimed or terminal, exiting`);
    process.exit(0);
  }

  // 2. spawn pi（只传 task_id，content 让 pi 走 $VKANBAN_CLI -t 查 DB）
  //    非 debug 模式加 -p 避免 pi 进入交互模式等待用户输入
  let piProc;
  try {
    const isDebug = process.env.VKANBAN_DEBUG === "1";
    const prompt = "execute your kanban task";
    const piArgs = isDebug
      ? [...piCmdParts, "--vkanban", taskId, prompt]
      : [...piCmdParts, "--vkanban", taskId, "-p", prompt];
    piProc = Bun.spawn(piArgs, {
      cwd: projectPath,
      env: {
        ...process.env,
        VKANBAN_TASK_ID: taskId,
        // 透传父进程注入的 VKANBAN_CLI（不要在此调用 resolveCliPath()）
        VKANBAN_CLI: process.env.VKANBAN_CLI!,
        VKANBAN_HOME: process.env.VKANBAN_HOME!,
        VKANBAN_DB: dbPath,
        VKANBAN_PROJECT_PATH: projectPath,
      },
      detached: true,
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch (e) {
    db.query(
      `UPDATE tasks SET status='failed', error_code='spawn_failed',
       output=?, finished_at=?, updated_at=?
       WHERE id=? AND status='running'`
    ).run(String(e), now(), now(), taskId);
    console.error(`[supervisor] failed to spawn pi for task ${taskId}`);
    process.exit(1);
  }

  // 3. 等待 pi 退出
  const exitCode = await piProc.exited;

  // 4. 检查 task 终态：若 pi 仍未调 -s/--fail/cancel 写回，兜底
  const row = db.query(`SELECT status FROM tasks WHERE id=?`).get(taskId) as { status: string } | undefined;
  if (row && row.status === "running") {
    const msg = `pi exited (code=${exitCode}) without writing back. ` +
                `Use: vkanban -t ${taskId} -s "<output>" or --fail "<reason>"`;
    db.query(
      `UPDATE tasks SET status='failed', error_code='pi_exited_no_callback',
       output=?, finished_at=?, updated_at=?
       WHERE id=? AND status='running'`
    ).run(msg, now(), now(), taskId);
  }
  // 终态已由 -s/--fail/cancel 写入：no-op
  process.exit(0);
}

main();
