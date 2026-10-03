import { loadConfig } from "../config/loader.js";
import { readCode } from "../search/read.js";
import { SearchService } from "../search/service.js";
import { SymbolService } from "../symbols/service.js";
import { TaskService } from "../task-state/service.js";
import { WorkspaceRegistry } from "../workspace/registry.js";
import { codeRef, parseContextRef } from "./refs.js";
import type { ContextBackend, ContextReference, FindRequest, InspectRequest } from "./types.js";

export class CodeBackend implements ContextBackend {
  readonly source = "code" as const;
  constructor(private readonly registry: WorkspaceRegistry, private readonly tasks: TaskService, private readonly resolveWorkspace: (explicit?: string) => Promise<string>) {}
  async find(request: FindRequest): Promise<ContextReference[]> {
    const workspaceId = await this.resolveWorkspace(request.workspace);
    const repositories = await this.registry.forScope(workspaceId, request.scope && request.scope !== "auto" ? request.scope : "all");
    const response = await new SearchService(await loadConfig()).search(repositories, request.query, "auto", Math.min(20, (request.limit || 8) * 2));
    const active = await this.tasks.current(workspaceId);
    return response.results.map((result) => {
      let bias = 0; const reasons = [result.reason];
      if (active?.relevant_files.some((file) => file.repo === result.repo && file.path === result.path)) { bias += 10; reasons.push("active-memory file"); }
      if (result.symbol && active?.relevant_symbols.includes(result.symbol)) { bias += 5; reasons.push("active-memory symbol"); }
      return { ref: codeRef(result.repo, result.path, result.start_line, result.end_line, result.symbol), source: this.source,
        title: `${result.repo}:${result.path}:${result.start_line}`, snippet: result.snippet.slice(0, 1000), score: result.score + bias,
        reason: reasons.join("; "), metadata: { repo: result.repo, path: result.path, start_line: result.start_line, end_line: result.end_line, symbol: result.symbol } };
    }).sort((a, b) => b.score - a.score || a.ref.localeCompare(b.ref));
  }
  async inspect(request: InspectRequest): Promise<unknown> {
    const parsed = parseContextRef(request.ref);
    if (parsed.source !== "code" || !parsed.repo || !parsed.path) throw new Error("Not a code reference");
    const workspaceId = await this.resolveWorkspace(request.workspace); const repository = await this.registry.resolveRepository(workspaceId, parsed.repo);
    const config = await loadConfig(); const view = request.view || "content";
    if (view === "content" || view === "surrounding") {
      const padding = view === "surrounding" ? 30 : 0;
      return readCode(repository, parsed.path, Math.max(1, (parsed.start || 1) - padding), (parsed.end || parsed.start || 1) + padding,
        config.limits.read_max_lines, config.limits.output_max_bytes);
    }
    if (!parsed.symbol) return { ref: request.ref, view, results: [], degraded: "Reference has no symbol identity; inspect content first" };
    return new SymbolService(config).relations(repository, parsed.symbol, view === "references" ? "references" : "dependencies", 1);
  }
}
