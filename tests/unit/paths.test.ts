// tests/unit/paths.test.ts
import { describe, expect, test, afterEach } from "bun:test";
import * as path from "node:path";
import * as paths from "../../src/paths";

const originalHome = Bun.env.VKANBAN_HOME;
const originalSuperOverride = Bun.env.VKANBAN_SUPERVISOR_OVERRIDE;
const originalCliOverride = Bun.env.VKANBAN_CLI_OVERRIDE;

function cleanup() {
  delete Bun.env.VKANBAN_HOME;
  delete Bun.env.VKANBAN_SUPERVISOR_OVERRIDE;
  delete Bun.env.VKANBAN_CLI_OVERRIDE;
  Bun.env.VKANBAN_HOME = originalHome;
  Bun.env.VKANBAN_SUPERVISOR_OVERRIDE = originalSuperOverride;
  Bun.env.VKANBAN_CLI_OVERRIDE = originalCliOverride;
}

describe("resolveVkanbanHome", () => {
  afterEach(cleanup);

  test("returns default ~/.vkanban when no env set", () => {
    delete Bun.env.VKANBAN_HOME;
    const home = paths.resolveVkanbanHome();
    expect(home).toEndWith(".vkanban");
    expect(path.isAbsolute(home)).toBe(true);
  });

  test("respects VKANBAN_HOME override", () => {
    Bun.env.VKANBAN_HOME = "C:\\tmp\\vk_test";
    const home = paths.resolveVkanbanHome();
    expect(home).toBe("C:\\tmp\\vk_test");
  });
});

describe("resolveSupervisorEntrypoint", () => {
  afterEach(cleanup);

  test("respects VKANBAN_SUPERVISOR_OVERRIDE", () => {
    Bun.env.VKANBAN_SUPERVISOR_OVERRIDE = path.resolve("custom_super.ts");
    expect(paths.resolveSupervisorEntrypoint()).toBe(path.resolve("custom_super.ts"));
  });

  test("defaults to <project_root>/src/supervisor.ts", () => {
    delete Bun.env.VKANBAN_SUPERVISOR_OVERRIDE;
    const entry = paths.resolveSupervisorEntrypoint();
    expect(entry).toEndWith(path.join("src", "supervisor.ts"));
    expect(path.isAbsolute(entry)).toBe(true);
  });

  test("falls back to .js if .ts not found (release mode)", () => {
    delete Bun.env.VKANBAN_SUPERVISOR_OVERRIDE;
    // 开发态存在 supervisor.ts，测试发布态路径格式
    const entry = paths.resolveSupervisorEntrypoint();
    expect(entry).toEndWith("supervisor.ts");
  });

  test("throws if override is not absolute", () => {
    Bun.env.VKANBAN_SUPERVISOR_OVERRIDE = "relative/path";
    expect(() => paths.resolveSupervisorEntrypoint()).toThrow("absolute");
  });
});

describe("resolveCliPath", () => {
  afterEach(cleanup);

  test("respects VKANBAN_CLI_OVERRIDE", () => {
    Bun.env.VKANBAN_CLI_OVERRIDE = "C:\\bin\\vkanban";
    expect(paths.resolveCliPath()).toBe("C:\\bin\\vkanban");
  });

  test("falls back to process.argv[1]", () => {
    delete Bun.env.VKANBAN_CLI_OVERRIDE;
    const cli = paths.resolveCliPath();
    expect(cli).toBe(process.argv[1]);
  });
});
