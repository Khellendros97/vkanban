import { describe, test, expect } from "bun:test";
import * as path from "node:path";
import { buildServiceCommand } from "../../src/service";

describe("service command builder", () => {
  test("builds install command with defaults", () => {
    const cliPath = path.resolve("src/cli.ts");
    const result = buildServiceCommand("install", {
      serviceName: "vkanban-daemon",
      displayName: "vkanban daemon",
      startType: "auto",
      cliPath,
      bunPath: "C:\\bin\\bun.exe",
    });

    expect(result.executable).toBe("sc.exe");
    expect(result.args[0]).toBe("create");
    expect(result.args).toContain("vkanban-daemon");
    expect(result.args.join(" ")).toContain("binPath=");
    expect(result.args.join(" ")).toContain("daemon");
    expect(result.args.join(" ")).toContain("start=");
    expect(result.args.join(" ")).toContain("auto");
  });

  test("builds lifecycle commands", () => {
    expect(buildServiceCommand("start", { serviceName: "vk" }).args).toEqual(["start", "vk"]);
    expect(buildServiceCommand("stop", { serviceName: "vk" }).args).toEqual(["stop", "vk"]);
    expect(buildServiceCommand("uninstall", { serviceName: "vk" }).args).toEqual(["delete", "vk"]);
    expect(buildServiceCommand("status", { serviceName: "vk" }).args).toEqual(["query", "vk"]);
  });
});
