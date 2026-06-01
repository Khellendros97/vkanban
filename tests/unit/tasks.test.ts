import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { nanoid } from "nanoid";
import { initDb, closeDb } from "../../src/db";
import {
  insertTask,
  casPendingToRunning,
  casClaimTask,
  casRunningToDone,
  casRunningToFailed,
  casRunningToCancelled,
  getTaskById,
  listTasksByProject,
} from "../../src/tasks";

const TEST_HOME = path.join(os.tmpdir(), "vkanban_task_test_" + Date.now());

beforeAll(() => {
  Bun.env.VKANBAN_HOME = TEST_HOME;
  fs.mkdirSync(TEST_HOME, { recursive: true });
  initDb();
});

afterAll(() => {
  closeDb();
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

describe("tasks — insert and query", () => {
  const projectName = "test_p";
  const projectPath = TEST_HOME;
  let taskId: string;

  test("insertTask creates a pending task", () => {
    taskId = nanoid(12);
    const task = insertTask({
      id: taskId,
      project_name: projectName,
      project_path: projectPath,
      content: "do something",
    });
    expect(task.status).toBe("pending");
    expect(task.id).toBe(taskId);
  });

  test("insertTask enforces content length CHECK", () => {
    const huge = "x".repeat(66000);
    expect(() => insertTask({
      id: nanoid(12),
      project_name: projectName,
      project_path: projectPath,
      content: huge,
    })).toThrow();
  });

  test("getTaskById returns a task", () => {
    const task = getTaskById(taskId);
    expect(task!.project_name).toBe(projectName);
  });

  test("getTaskById returns null for missing id", () => {
    expect(getTaskById("nonexistent")).toBeNull();
  });

  test("listTasksByProject returns tasks sorted by created_at DESC", () => {
    const list = listTasksByProject(projectName, 50);
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(new Date(list[0].created_at) >= new Date(list[list.length - 1].created_at)).toBe(true);
  });
});

describe("tasks — CAS transitions", () => {
  const projectName = "tran_p";
  let id1: string, id2: string, id3: string, id4: string;

  beforeAll(() => {
    id1 = nanoid(12); id2 = nanoid(12); id3 = nanoid(12); id4 = nanoid(12);
    insertTask({ id: id1, project_name: projectName, project_path: TEST_HOME, content: "a" });
    insertTask({ id: id2, project_name: projectName, project_path: TEST_HOME, content: "b" });
    insertTask({ id: id3, project_name: projectName, project_path: TEST_HOME, content: "c" });
    insertTask({ id: id4, project_name: projectName, project_path: TEST_HOME, content: "d" });
  });

  test("casPendingToRunning transitions pending→running", () => {
    const result = casPendingToRunning(id1);
    expect(result.changed).toBe(true);
    expect(result.status).toBe("running");
  });

  test("casPendingToRunning is idempotent-safe", () => {
    const result = casPendingToRunning(id1);
    expect(result.changed).toBe(false);
  });

  test("casClaimTask claims with claimed_at", () => {
    casPendingToRunning(id2);
    const result = casClaimTask(id2);
    expect(result.claimed).toBe(true);
    expect(result.claimed_at).toBeTruthy();
  });

  test("casClaimTask is exclusive", () => {
    const result = casClaimTask(id2);
    expect(result.claimed).toBe(false);
  });

  test("casRunningToDone writes output", () => {
    casPendingToRunning(id3);
    const result = casRunningToDone(id3, "success");
    expect(result.changed).toBe(true);
    expect(result.status).toBe("done");
  });

  test("casRunningToDone on done task returns false", () => {
    const result = casRunningToDone(id3, "extra");
    expect(result.changed).toBe(false);
  });

  test("casRunningToCancelled", () => {
    casPendingToRunning(id4);
    const result = casRunningToCancelled(id4);
    expect(result.changed).toBe(true);
    expect(result.error_code).toBe("cancelled");
  });

  test("casRunningToFailed with error_code", () => {
    const id5 = nanoid(12);
    insertTask({ id: id5, project_name: projectName, project_path: TEST_HOME, content: "x" });
    casPendingToRunning(id5);
    const result = casRunningToFailed(id5, "spawn_failed", "spawn error");
    expect(result.changed).toBe(true);
    expect(result.status).toBe("failed");
    expect(result.error_code).toBe("spawn_failed");
  });
});
