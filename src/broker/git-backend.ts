import { loadConfig } from "../config/loader.js";
import { ReadonlyGit } from "../git/readonly.js";
import { SymbolService } from "../symbols/service.js";
import { WorkspaceRegistry } from "../workspace/registry.js";
import { gitCommitRef, gitFileRef, parseContextRef } from "./refs.js";
import type { ContextBackend, ContextReference, FindRequest, InspectRequest } from "./types.js";

export class GitBackend implements ContextBackend {
  readonly source = "git" as const;
  private readonly git: ReadonlyGit;
  constructor(private readonly registry: WorkspaceRegistry, private readonly resolveWorkspace: (explicit?: string) => Promise<string>, maxBytes = 16_000) {
    this.git = new ReadonlyGit(maxBytes);
  }
  async find(request: FindRequest): Promise<ContextReference[]> {
    const workspaceId = await this.resolveWorkspace(request.workspace);
    const repositories = await this.registry.forScope(workspaceId, request.scope && request.scope !== "auto" ? request.scope : "all");
    const rows = (await Promise.all(repositories.map(async (repo) => ({ repo, matches: await this.git.searchHistory(repo, request.query, request.limit || 8) })))).flatMap(({ repo, matches }) => matches.map((match, index) => ({ repo, match, index })));
    return rows.sort((a, b) => b.match.date.localeCompare(a.match.date)).slice(0, Math.min(20, request.limit || 8)).map(({ repo, match, index }) => ({
      ref: gitCommitRef(repo.id, match.commit), source: this.source, title: `${match.commit.slice(0, 10)} ${match.subject}`,
      snippet: `${match.date}\n${match.files.slice(0, 8).join("\n")}`.slice(0, 1000), score: 1 / (index + 1), reason: match.reason,
      metadata: { repo: repo.id, commit: match.commit, date: match.date, subject: match.subject, changed_files: match.files },
    }));
  }
  async inspect(request: InspectRequest): Promise<unknown> {
    const parsed = parseContextRef(request.ref);
    if (parsed.source !== "git" || !parsed.repo || !parsed.commit) throw new Error("Invalid Git context reference");
    const workspaceId = await this.resolveWorkspace(request.workspace); const repository = await this.registry.resolveRepository(workspaceId, parsed.repo);
    if (parsed.kind === "file") {
      if (!parsed.path) throw new Error("Git file reference has no path");
      if (request.view === "blame") return this.git.blame(repository, parsed.path, parsed.commit);
      return this.git.commitDiff(repository, parsed.commit, parsed.path);
    }
    const view = request.view === "content" ? "summary" : request.view || "summary";
    if (view === "diff") return this.git.commitDiff(repository, parsed.commit);
    const summary = await this.git.commitSummary(repository, parsed.commit);
    const fileRefs = summary.files.slice(0, 30).map((file) => ({ path: file.path, ref: gitFileRef(repository.id, summary.commit, file.path) }));
    if (view === "impact") {
      const symbols = new SymbolService(await loadConfig());
      const hints = (await Promise.all(summary.changed_symbols.slice(0, 8).map((name) => symbols.symbol([repository], name)))).flatMap((item) => item.results).slice(0, 30);
      return { ...summary, file_refs: fileRefs, impact_hints: hints };
    }
    return { ...summary, file_refs: fileRefs, next: "Inspect a file_ref or request view=impact; request view=diff only when a bounded whole-commit patch is needed." };
  }
}
