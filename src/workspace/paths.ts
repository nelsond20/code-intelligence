import os from "node:os";
import path from "node:path";

export interface AppPaths {
  configFile: string;
  dataDir: string;
  indexDir: string;
  workspaceDir: string;
  opencodeDir: string;
}

export function appPaths(env: NodeJS.ProcessEnv = process.env): AppPaths {
  const home = env.HOME || os.homedir();
  const configFile = env.CODE_INTELLIGENCE_CONFIG || path.join(home, ".config", "code-intelligence", "config.toml");
  const dataDir = env.CODE_INTELLIGENCE_DATA_DIR || path.join(home, ".local", "share", "code-intelligence");
  return {
    configFile,
    dataDir,
    indexDir: path.join(dataDir, "indexes"),
    workspaceDir: path.join(dataDir, "workspaces"),
    opencodeDir: env.OPENCODE_CONFIG_DIR || path.join(home, ".config", "opencode"),
  };
}

export function assertSafeId(value: string, label = "id"): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(value)) throw new Error(`Invalid ${label}: use lowercase letters, numbers, and hyphens`);
  return value;
}

export function slugify(value: string): string {
  const slug = value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  return slug || "task";
}
