import { describe, test, expect } from "bun:test";
import * as path from "node:path";
import { buildServiceCommand } from "../../src/service";

describe("service command builder (schtasks + wscript)", () => {
  test("builds install command pointing to wscript", () => {
    const result = buildServiceCommand("install", {
      serviceName: "vkanban-daemon",
      vbsPath: "C:\\Users\\test\\.vkanban\\daemon-launcher.vbs",
    });

    expect(result.executable).toBe("schtasks.exe");
    expect(result.args[0]).toBe("/create");
    expect(result.args).toContain("/tn");
    expect(result.args).toContain("vkanban-daemon");
    expect(result.args).toContain("/sc");
    expect(result.args).toContain("onstart");
    expect(result.args.join(" ")).toContain("wscript.exe");
    expect(result.args.join(" ")).toContain("daemon-launcher.vbs");
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
