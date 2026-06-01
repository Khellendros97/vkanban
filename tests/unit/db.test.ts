import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { initDb, getDb, closeDb } from "../../src/db";

const TEST_HOME = path.join(require("node:os").tmpdir(), "vkanban_db_test_" + Date.now());
const TEST_DB = path.join(TEST_HOME, "data.db");

beforeAll(() => {
  Bun.env.VKANBAN_HOME = TEST_HOME;
  if (!fs.existsSync(TEST_HOME)) {
    fs.mkdirSync(TEST_HOME, { recursive: true });
  }
  initDb();
});

afterAll(() => {
  closeDb();
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

describe("db — schema init", () => {
  test("data.db file created", () => {
    expect(fs.existsSync(TEST_DB)).toBe(true);
  });

  test("tasks table exists with all columns", () => {
    const db = getDb();
    const cols = db.query("PRAGMA table_info(tasks)").all() as { name: string }[];
    const colNames = cols.map((c) => c.name).sort();
    expect(colNames).toEqual([
      "claimed_at", "content", "created_at", "error_code",
      "finished_at", "id", "output", "project_name", "project_path",
      "started_at", "status", "updated_at",
    ]);
  });

  test("projects table exists", () => {
    const db = getDb();
    const cols = db.query("PRAGMA table_info(projects)").all() as { name: string }[];
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("name");
    expect(colNames).toContain("path");
  });

  test("WAL journal mode is active", () => {
    const db = getDb();
    const pragma = db.query("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(pragma.journal_mode).toBe("wal");
  });

  test("busy_timeout is set", () => {
    const db = getDb();
    const pragma = db.query("PRAGMA busy_timeout").get() as { timeout: number };
    expect(pragma.timeout).toBe(5000);
  });

  test("CHECK constraint rejects invalid status", () => {
    const db = getDb();
    expect(() => db.query(
      `INSERT INTO tasks (id, project_name, project_path, content, status, created_at, updated_at)
       VALUES ('test1','p','/','x','invalid','2026-01-01','2026-01-01')`
    ).run()).toThrow();
  });
});
