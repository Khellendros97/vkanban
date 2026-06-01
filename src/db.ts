// src/db.ts
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveVkanbanHome } from "./paths";

let db: Database | null = null;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projects (
  name          TEXT PRIMARY KEY,
  path          TEXT NOT NULL,
  registered_at TEXT NOT NULL,
  removed_at    TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  id            TEXT PRIMARY KEY,
  project_name  TEXT NOT NULL,
  project_path  TEXT NOT NULL,
  content       TEXT NOT NULL,
  output        TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL,
  error_code    TEXT,
  claimed_at    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  started_at    TEXT,
  finished_at   TEXT,

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
  CHECK (length(content) <= 65536),
  CHECK (length(output)  <= 1048576)
);

CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_status  ON tasks(status, updated_at DESC);
`;

/**
 * 初始化 SQLite 数据库（创建目录、建表、设置 PRAGMA）。
 * 幂等安全，可重复调用。
 */
export function initDb(): Database {
  const home = resolveVkanbanHome();
  if (!fs.existsSync(home)) {
    fs.mkdirSync(home, { recursive: true });
  }
  const dbPath = path.join(home, "data.db");
  db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  return db;
}

/**
 * 获取已初始化的数据库实例。
 * 未调用 initDb() 前调用会抛错。
 */
export function getDb(): Database {
  if (!db) throw new Error("DB not initialized. Call initDb() first.");
  return db;
}

/**
 * 关闭数据库连接并释放资源。
 */
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
