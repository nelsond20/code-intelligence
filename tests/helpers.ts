import path from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { defaultConfig } from "../src/config/schema.js";
import { saveConfig } from "../src/config/loader.js";
import { WorkspaceRegistry } from "../src/workspace/registry.js";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.basename(path.dirname(testDirectory)) === "dist" ? path.resolve(testDirectory, "../..") : path.resolve(testDirectory, "..");
export const fixture = (name: string) => path.join(projectRoot, "tests", "fixtures", name);

export async function isolated(name: string) {
  const root = path.join(projectRoot, "tests", ".runtime", `${name}-${process.pid}-${Date.now()}`);
  await mkdir(root, { recursive: true });
  const config = path.join(root, "config.toml"); const data = path.join(root, "data"); const opencode = path.join(root, "opencode");
  process.env.CODE_INTELLIGENCE_CONFIG = config; process.env.CODE_INTELLIGENCE_DATA_DIR = data; process.env.OPENCODE_CONFIG_DIR = opencode;
  const value = defaultConfig(); value.embeddings.enabled = false; await saveConfig(value, config);
  return { root, config, data, opencode, cleanup: async () => { try { await rm(root, { recursive: true, force: true }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
  } } };
}

export async function fixtureWorkspace(name: string) {
  const env = await isolated(name); const registry = new WorkspaceRegistry(env.config, path.join(env.data, "workspaces"));
  await registry.add("planning", [fixture("frontend"), fixture("backend"), fixture("shared")]);
  process.env.CODE_INTELLIGENCE_WORKSPACE = "planning";
  return { ...env, registry };
}
