import type { CodeIntelligenceConfig, Repository } from "../config/schema.js";
import { GraphifyAdapter } from "../graph/graphify-adapter.js";
import { fallbackRelations } from "../graph/fallback.js";
import { fallbackSymbolSearch } from "./fallback.js";
import { SerenaAdapter } from "./serena-adapter.js";

export class SymbolService {
  readonly serena: SerenaAdapter;
  readonly graphify: GraphifyAdapter;
  constructor(private readonly config: CodeIntelligenceConfig) {
    this.serena = new SerenaAdapter(config.serena.command, config.serena.timeout_ms);
    this.graphify = new GraphifyAdapter(config.graphify.command, config.graphify.timeout_ms);
  }

  async symbol(repositories: Repository[], name: string) {
    if (this.config.serena.enabled && await this.serena.available()) {
      try {
        const found = (await Promise.all(repositories.map((repo) => this.serena.symbol(repo, name)))).flat().slice(0, 20);
        if (found.length) return { results: found, backend: "serena" };
      } catch { /* fallback is deliberately fail-open */ }
    }
    return { results: await fallbackSymbolSearch(repositories, name), backend: "local-fallback",
      degraded: this.config.serena.enabled ? "Serena unavailable or query failed" : "Serena disabled" };
  }

  async relations(repository: Repository, symbol: string, direction: string, depth: number) {
    const boundedDepth = Math.max(1, Math.min(3, depth));
    if (this.config.graphify.enabled && await this.graphify.available()) {
      try { return { results: await this.graphify.relations(repository, symbol, direction, boundedDepth), backend: "graphify" }; } catch { /* continue */ }
    }
    if (direction === "references" && this.config.serena.enabled && await this.serena.available()) {
      try { return { results: await this.serena.references(repository, symbol), backend: "serena" }; } catch { /* continue */ }
    }
    return { results: await fallbackRelations(repository, symbol, direction, boundedDepth), backend: "local-fallback",
      degraded: "optional structural engine unavailable or disabled" };
  }
}
