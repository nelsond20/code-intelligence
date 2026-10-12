import path from "node:path";
import { access } from "node:fs/promises";
import { loadConfig, saveConfig } from "../config/loader.js";
import type { CodeIntelligenceConfig, Repository, Workspace } from "../config/schema.js";
import { assertReadableDirectory, atomicWrite } from "../shared/fs.js";
import { appPaths, assertSafeId, slugify } from "./paths.js";

export class WorkspaceRegistry {
  constructor(private readonly configFile = appPaths().configFile, private readonly dataRoot = appPaths().workspaceDir) {}

  async config(): Promise<CodeIntelligenceConfig> { return loadConfig(this.configFile); }
  async list(): Promise<Workspace[]> { return (await this.config()).workspaces; }

  async get(id: string): Promise<Workspace> {
    const workspace = (await this.list()).find((item) => item.id === id);
    if (!workspace) throw new Error(`Unknown workspace: ${id}`);
    return workspace;
  }

  async add(id: string, repositoryPaths: string[], name = id): Promise<Workspace> {
    assertSafeId(id, "workspace id");
    if (repositoryPaths.length === 0) throw new Error("At least one --repo path is required");
    const config = await this.config();
    if (config.workspaces.some((item) => item.id === id)) throw new Error(`Workspace already exists: ${id}`);
    const repositories: Repository[] = [];
    const used = new Set<string>();
    for (const repositoryPath of repositoryPaths) {
      const canonical = await assertReadableDirectory(repositoryPath);
      let repositoryId = slugify(path.basename(canonical));
      let suffix = 2;
      while (used.has(repositoryId)) repositoryId = `${slugify(path.basename(canonical))}-${suffix++}`;
      used.add(repositoryId);
      repositories.push({ id: repositoryId, path: canonical });
    }
    const workspace: Workspace = { id, name, repositories, verification: [] };
    config.workspaces.push(workspace);
    await saveConfig(config, this.configFile);
    await atomicWrite(path.join(this.dataRoot, id, "workspace.json"), `${JSON.stringify({ schema_version: 1, ...workspace }, null, 2)}\n`);
    return workspace;
  }

  async remove(id: string): Promise<void> {
    assertSafeId(id, "workspace id");
    const config = await this.config();
    const next = config.workspaces.filter((item) => item.id !== id);
    if (next.length === config.workspaces.length) throw new Error(`Unknown workspace: ${id}`);
    config.workspaces = next;
    await saveConfig(config, this.configFile);
  }

  async addRepository(workspaceId: string, repositoryPath: string, requestedId?: string): Promise<Repository> {
    const config = await this.config();
    const workspace = config.workspaces.find((item) => item.id === workspaceId);
    if (!workspace) throw new Error(`Unknown workspace: ${workspaceId}`);
    const canonical = await assertReadableDirectory(repositoryPath);
    const id = assertSafeId(requestedId || slugify(path.basename(canonical)), "repository id");
    if (workspace.repositories.some((repo) => repo.id === id || repo.path === canonical)) throw new Error("Repository id or path already registered");
    const repository = { id, path: canonical };
    workspace.repositories.push(repository);
    await saveConfig(config, this.configFile);
    await atomicWrite(path.join(this.dataRoot, workspaceId, "workspace.json"), `${JSON.stringify({ schema_version: 1, ...workspace }, null, 2)}\n`);
    return repository;
  }

  async removeRepository(workspaceId: string, repositoryId: string): Promise<void> {
    const config = await this.config();
    const workspace = config.workspaces.find((item) => item.id === workspaceId);
    if (!workspace) throw new Error(`Unknown workspace: ${workspaceId}`);
    const remaining = workspace.repositories.filter((repo) => repo.id !== repositoryId);
    if (remaining.length === workspace.repositories.length) throw new Error(`Unknown repository: ${repositoryId}`);
    workspace.repositories = remaining;
    await saveConfig(config, this.configFile);
    await atomicWrite(path.join(this.dataRoot, workspaceId, "workspace.json"), `${JSON.stringify({ schema_version: 1, ...workspace }, null, 2)}\n`);
  }

  async resolveRepository(workspaceId: string, repositoryId: string): Promise<Repository> {
    const workspace = await this.get(workspaceId);
    const repository = workspace.repositories.find((item) => item.id === repositoryId);
    if (!repository) throw new Error(`Unknown repository ${repositoryId} in workspace ${workspaceId}`);
    await access(repository.path);
    return repository;
  }

  async forScope(workspaceId: string, scope: string): Promise<Repository[]> {
    const workspace = await this.get(workspaceId);
    if (scope === "all") return workspace.repositories;
    const repository = workspace.repositories.find((item) => item.id === scope);
    if (!repository) throw new Error(`Unknown repository scope: ${scope}`);
    return [repository];
  }
}

export function resolveWorkspaceId(explicit?: string): string {
  const value = explicit || process.env.CODE_INTELLIGENCE_WORKSPACE;
  if (!value) throw new Error("Workspace is required; pass --workspace or set CODE_INTELLIGENCE_WORKSPACE");
  return assertSafeId(value, "workspace id");
}
