export interface SearchResult {
  repo: string;
  path: string;
  start_line: number;
  end_line: number;
  symbol?: string;
  snippet: string;
  reason: string;
  lexical_score?: number;
  semantic_score?: number;
  score: number;
}

export interface SearchResponse {
  results: SearchResult[];
  mode: "lexical" | "semantic" | "auto";
  degraded?: string;
  truncated: boolean;
}
