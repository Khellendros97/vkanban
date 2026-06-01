// src/registry.ts
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveVkanbanHome } from "./paths";

const NAME_REGEX = /^[A-Za-z0-9_.-]{1,64}$/;

export interface RegistryEntry {
  name: string;
  path: string;
  registered_at: string;
  removed_at: string | null;
}

export function initRegistry(): void {
  const home = resolveVkanbanHome();
  if (!fs.existsSync(home)) {
    fs.mkdirSync(home, { recursive: true });
  }
  const regPath = path.join(home, "registry.json");
  if (!fs.existsSync(regPath)) {
    fs.writeFileSync(regPath, "[]", { encoding: "utf-8" });
  }
}

function readRegistry(): RegistryEntry[] {
  const home = resolveVkanbanHome();
  const regPath = path.join(home, "registry.json");
  if (!fs.existsSync(regPath)) return [];
  const raw = fs.readFileSync(regPath, { encoding: "utf-8" });
  return JSON.parse(raw);
}

function writeRegistry(projects: unknown[]): void {
  const home = resolveVkanbanHome();
  const regPath = path.join(home, "registry.json");
  fs.writeFileSync(regPath, JSON.stringify(projects, null, 2), { encoding: "utf-8" });
}

export function registerProject(name: string, dir: string): RegistryEntry {
  if (!NAME_REGEX.test(name)) {
    throw new Error(`Invalid project name: "${name}". Must be 1-64 chars of [A-Za-z0-9_.-].`);
  }
  const abs = path.resolve(dir);
  const projects = readRegistry();
  if (projects.find((p) => p.name === name && p.removed_at === null)) {
    throw new Error(`Project "${name}" already registered.`);
  }
  const entry: RegistryEntry = {
    name,
    path: abs,
    registered_at: new Date().toISOString(),
    removed_at: null,
  };
  projects.push(entry);
  writeRegistry(projects);
  return entry;
}

export function getProject(name: string): RegistryEntry | null {
  const projects = readRegistry();
  return projects.find((p) => p.name === name && p.removed_at === null) ?? null;
}

export function listProjects(): RegistryEntry[] {
  return readRegistry().filter((p) => p.removed_at === null);
}

export function removeProject(name: string): RegistryEntry {
  const projects = readRegistry();
  const idx = projects.findIndex((p) => p.name === name && p.removed_at === null);
  if (idx === -1) throw new Error(`Project "${name}" not found in registry.`);
  projects[idx].removed_at = new Date().toISOString();
  writeRegistry(projects);
  return projects[idx];
}
