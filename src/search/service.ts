import type { CodeIntelligenceConfig, Repository } from "../config/schema.js";
import { lexicalSearch } from "./lexical.js";
import { SemanticIndex } from "./semantic.js";
import { fuseResults } from "./fusion.js";
import type { SearchResponse } from "./types.js";

export class SearchService {
  readonly semantic: SemanticIndex;
  constructor(private readonly config: CodeIntelligenceConfig, semantic?: SemanticIndex) { this.semantic = semantic || new SemanticIndex(config); }

  async search(repositories: Repository[], query: string, mode: "auto" | "lexical" | "semantic" = "auto", limit = 8): Promise<SearchResponse> {
    const bounded = Math.max(1, Math.min(20, limit));
    if (mode === "lexical") return { results: await lexicalSearch(repositories, query, bounded), mode, truncated: false };
    if (mode === "semantic") {
      if (!this.config.embeddings.enabled) throw new Error("Semantic search is disabled");
      return { results: await this.semantic.search(repositories, query, bounded), mode, truncated: false };
    }
    const lexical = await lexicalSearch(repositories, query, bounded * 2);
    if (!this.config.embeddings.enabled) return { results: lexical.slice(0, bounded), mode, degraded: "semantic search disabled", truncated: lexical.length > bounded };
    try {
      const semantic = await this.semantic.search(repositories, query, bounded * 2);
      return { results: fuseResults(lexical, semantic, bounded), mode, truncated: false };
    } catch (error) {
      return { results: lexical.slice(0, bounded), mode, degraded: `semantic unavailable: ${(error as Error).message}`, truncated: lexical.length > bounded };
    }
  }
}
