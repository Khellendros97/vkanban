import { describe, test, expect } from "bun:test";
import * as path from "node:path";
import { buildServiceCommand } from "../../src/service";

describe("service command builder (schtasks)", () => {
  test("builds install command", () => {
    const cliPath = path.resolve("src/cli.ts");
    const result = buildServiceCommand("install", {
      serviceName: "vkanban-daemon",
      cliPath,
      bunPath: "C:\\bin\\bun.exe",
      vkHome: "C:\\Users\\test\\.vkanban",
    });

    expect(result.executable).toBe("schtasks.exe");
    expect(result.args[0]).toBe("/create");
    expect(result.args).toContain("/tn");
    expect(result.args).toContain("vkanban-daemon");
    expect(result.args).toContain("/sc");
    expect(result.args).toContain("onstart");
    expect(result.args).toContain("/ru");
    expect(result.args).toContain("SYSTEM");
    expect(result.args.join(" ")).toContain("daemon");
    expect(result.args.join(" ")).toContain("VKANBAN_HOME");
  });

  test("builds lifecycle commands", () => {
    const result = buildServiceCommand("start", { serviceName: "vk" });
    expect(result.executable).toBe("schtasks.exe");
    expect(result.args).toEqual(["/run", "/tn", "vk"]);

    expect(buildServiceCommand("stop", { serviceName: "vk" }).args).toEqual(["/end", "/tn", "vk"]);
    expect(buildServiceCommand("uninstall", { serviceName: "vk" }).args).toEqual(["/delete", "/tn", "vk", "/f"]);
    expect(buildServiceCommand("status", { serviceName: "vk" }).args).toEqual(["/query", "/tn", "vk", "/fo", "LIST"]);
  });
});
