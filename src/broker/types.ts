export type ContextSource = "code" | "docs" | "vault" | "git";
export type InspectView = "content" | "surrounding" | "relations" | "references" | "summary" | "diff" | "file" | "impact" | "blame";

export interface ContextReference {
  ref: string;
  source: ContextSource;
  title: string;
  snippet: string;
  score: number;
  reason?: string;
  metadata?: Record<string, unknown>;
}
export interface FindRequest { query: string; workspace?: string; scope?: string; sources?: ContextSource[]; limit?: number; }
export interface InspectRequest { ref: string; view?: InspectView; workspace?: string; }
export interface ContextBackend {
  readonly source: ContextSource;
  find(request: FindRequest): Promise<ContextReference[]>;
  inspect(request: InspectRequest): Promise<unknown>;
}
