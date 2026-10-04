import { loadConfig } from "../config/loader.js";
import { readCode } from "../search/read.js";
import { SearchService } from "../search/service.js";
import { SymbolService } from "../symbols/service.js";
import { TaskService } from "../task-state/service.js";
import { WorkspaceRegistry } from "../workspace/registry.js";
import { codeRef, parseContextRef } from "./refs.js";
import type { ContextBackend, ContextReference, FindRequest, InspectRequest } from "./types.js";
import { RepositoryAccessPolicy } from "../privacy/repository-access.js";
import { readFile } from "node:fs/promises";
import { containingSymbol, parseSymbols } from "../symbols/parser.js";

export class CodeBackend implements ContextBackend {
  readonly source = "code" as const;
  constructor(private readonly registry: WorkspaceRegistry, private readonly tasks: TaskService, private readonly resolveWorkspace: (explicit?: string) => Promise<string>) {}
  async find(request: FindRequest): Promise<ContextReference[]> {
    const workspaceId = await this.resolveWorkspace(request.workspace);
    const repositories = await this.registry.forScope(workspaceId, request.scope && request.scope !== "auto" ? request.scope : "all");
    const active = await this.tasks.current(workspaceId);
    const expandedQuery = [request.query, active?.objective, ...(active?.relevant_symbols.slice(0, 5) || [])].filter(Boolean).join(" ");
    const response = await new SearchService(await loadConfig(), undefined, workspaceId).search(repositories, expandedQuery, "auto", Math.min(20, (request.limit || 8) * 2));
    return response.results.map((result) => {
      let bias = 0; const reasons = [result.reason];
      const availableViews: ContextReference["available_views"] = result.symbol
        ? ["content", "surrounding", "relations", "references"] : ["content", "surrounding"];
      const relevantIndex = active?.relevant_files.findIndex((file) => file.repo === result.repo && file.path === result.path) ?? -1;
      if (relevantIndex >= 0) { bias += Math.max(2, 8 - relevantIndex * 0.5); reasons.push("recent active-memory file"); }
      if (result.symbol && active?.relevant_symbols.includes(result.symbol)) { bias += 5; reasons.push("active-memory symbol"); }
      const ruledOut = active?.records.some((record) => record.status === "ruled_out"
        && ((!record.repo || record.repo === result.repo) && (!record.file || record.file === result.path) && (!record.symbol || record.symbol === result.symbol)));
      if (ruledOut) { bias -= 20; reasons.push("ruled out by active memory"); }
      return { ref: codeRef(result.repo, result.path, result.start_line, result.end_line, result.symbol), source: this.source,
        title: `${result.repo}:${result.path}:${result.start_line}`, snippet: result.snippet.slice(0, 1000), score: result.score + bias,
        reason: reasons.join("; "), available_views: availableViews,
        metadata: { repo: result.repo, path: result.path, start_line: result.start_line, end_line: result.end_line, symbol: result.symbol,
          diagnostics: response.diagnostics, degraded: response.degraded, original_query: request.query,
          expanded_query: expandedQuery === request.query ? undefined : expandedQuery } };
    }).sort((a, b) => b.score - a.score || a.ref.localeCompare(b.ref));
  }
  async inspect(request: InspectRequest): Promise<unknown> {
    const parsed = parseContextRef(request.ref);
    if (parsed.source !== "code" || !parsed.repo || !parsed.path) throw new Error("Not a code reference");
    const workspaceId = await this.resolveWorkspace(request.workspace); const repository = await this.registry.resolveRepository(workspaceId, parsed.repo);
    const config = await loadConfig(); const view = request.view || "content";
    if (view === "content" || view === "surrounding") {
      const padding = view === "surrounding" ? 30 : 0;
      const baseEnd = parsed.end ?? ((parsed.start || 1) + config.limits.read_default_lines - 1);
      return readCode(repository, parsed.path, Math.max(1, (parsed.start || 1) - padding), baseEnd + padding,
        config.limits.read_max_lines, config.limits.output_max_bytes);
    }
    let symbol = parsed.symbol;
    if (!symbol) {
      const resolved = await (await RepositoryAccessPolicy.create(repository.path)).resolveFile(parsed.path);
      symbol = containingSymbol(parseSymbols(await readFile(resolved.absolute, "utf8")), parsed.start || 1, parsed.end)?.qualified_name;
    }
    if (!symbol) return { ref: request.ref, view, results: [], degraded: "No containing symbol could be inferred for this range" };
    return new SymbolService(config).relations(repository, symbol, view === "references" ? "references" : "dependencies", 1);
  }
}
