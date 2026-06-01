// tests/unit/registry.test.ts
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { initRegistry, registerProject, getProject, listProjects, removeProject } from "../../src/registry";

const TEST_HOME = path.join(require("node:os").tmpdir(), "vkanban_reg_test_" + Date.now());
const REG_PATH = path.join(TEST_HOME, "registry.json");

beforeAll(() => {
  Bun.env.VKANBAN_HOME = TEST_HOME;
  fs.mkdirSync(TEST_HOME, { recursive: true });
  initRegistry();
});

afterAll(() => {
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

describe("registry", () => {
  test("registerProject adds a project", () => {
    const result = registerProject("myproj", path.join(TEST_HOME, "myproj"));
    expect(result.name).toBe("myproj");
    expect(fs.existsSync(REG_PATH)).toBe(true);
  });

  test("duplicate name throws", () => {
    expect(() => registerProject("myproj", path.join(TEST_HOME, "myproj2"))).toThrow();
  });

  test("getProject returns a project by name", () => {
    const proj = getProject("myproj");
    expect(proj!.name).toBe("myproj");
    expect(proj!.path).toBeTruthy();
  });

  test("getProject returns null for unknown name", () => {
    expect(getProject("nonexistent")).toBeNull();
  });

  test("listProjects returns all active projects", () => {
    registerProject("proj2", path.join(TEST_HOME, "proj2"));
    const list = listProjects();
    expect(list.length).toBe(2);
    expect(list.map((p: any) => p.name).sort()).toEqual(["myproj", "proj2"]);
  });

  test("removeProject marks removed_at", () => {
    const r = removeProject("myproj");
    expect(r.removed_at).toBeTruthy();
    const list = listProjects();
    expect(list.find((p: any) => p.name === "myproj")).toBeUndefined();
  });

  test("invalid project name throws", () => {
    expect(() => registerProject("", TEST_HOME)).toThrow();
    expect(() => registerProject("a b", TEST_HOME)).toThrow();
    expect(() => registerProject("..", TEST_HOME)).toThrow();
    expect(() => registerProject("proj/ect", TEST_HOME)).toThrow();
    expect(() => registerProject("../escape", TEST_HOME)).toThrow();
  });
});
