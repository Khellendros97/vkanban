import { getDb } from "./db";

export interface TaskInsert {
  id: string;
  project_name: string;
  project_path: string;
  content: string;
}

export interface TaskRow {
  id: string;
  project_name: string;
  project_path: string;
  content: string;
  output: string;
  status: string;
  error_code: string | null;
  claimed_at: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export function insertTask(t: TaskInsert): TaskRow {
  const now = new Date().toISOString();
  const db = getDb();
  db.query(
    `INSERT INTO tasks (id, project_name, project_path, content, output, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, '', 'pending', ?, ?)`
  ).run(t.id, t.project_name, t.project_path, t.content, now, now);
  return getTaskById(t.id)!;
}

export function casPendingToRunning(taskId: string): { changed: boolean; status: string } {
  const now = new Date().toISOString();
  const db = getDb();
  const result = db.query(
    `UPDATE tasks SET status='running', started_at=?, updated_at=?
     WHERE id=? AND status='pending'`
  ).run(now, now, taskId);
  if (result.changes === 1) return { changed: true, status: "running" };
  const row = db.query(`SELECT status FROM tasks WHERE id=?`).get(taskId) as { status: string } | undefined;
  return { changed: false, status: row?.status ?? "unknown" };
}

export function casClaimTask(taskId: string): { claimed: boolean; claimed_at: string | null } {
  const now = new Date().toISOString();
  const db = getDb();
  const result = db.query(
    `UPDATE tasks SET claimed_at=?, updated_at=?
     WHERE id=? AND status='running' AND claimed_at IS NULL`
  ).run(now, now, taskId);
  if (result.changes === 1) return { claimed: true, claimed_at: now };
  return { claimed: false, claimed_at: null };
}

export function casRunningToDone(taskId: string, output: string): { changed: boolean; status: string } {
  const now = new Date().toISOString();
  const db = getDb();
  const result = db.query(
    `UPDATE tasks SET status='done', output=?, finished_at=?, updated_at=?
     WHERE id=? AND status='running'`
  ).run(output, now, now, taskId);
  const row = db.query(`SELECT status FROM tasks WHERE id=?`).get(taskId) as { status: string } | undefined;
  return { changed: result.changes === 1, status: row?.status ?? "unknown" };
}

export function casRunningToFailed(
  taskId: string, error_code: string, output: string,
): { changed: boolean; status: string; error_code: string | null } {
  const now = new Date().toISOString();
  const db = getDb();
  const result = db.query(
    `UPDATE tasks SET status='failed', error_code=?, output=?, finished_at=?, updated_at=?
     WHERE id=? AND status='running'`
  ).run(error_code, output, now, now, taskId);
  const row = db.query(`SELECT status, error_code FROM tasks WHERE id=?`).get(taskId) as
    { status: string; error_code: string | null } | undefined;
  return {
    changed: result.changes === 1,
    status: row?.status ?? "unknown",
    error_code: row?.error_code ?? null,
  };
}

export function casRunningToCancelled(taskId: string): { changed: boolean; status: string; error_code: string | null } {
  return casRunningToFailed(taskId, "cancelled", "");
}

export function getTaskById(taskId: string): TaskRow | null {
  const db = getDb();
  return db.query(`SELECT * FROM tasks WHERE id=?`).get(taskId) as TaskRow | null;
}

export function listTasksByProject(projectName: string, limit: number = 50): TaskRow[] {
  const db = getDb();
  return db.query(
    `SELECT * FROM tasks WHERE project_name=? ORDER BY created_at DESC LIMIT ?`
  ).all(projectName, limit) as TaskRow[];
}
