import { z } from "zod";

export const repositorySchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  path: z.string().min(1),
});

export const workspaceSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string().min(1),
  repositories: z.array(repositorySchema).default([]),
});

export const configSchema = z.object({
  schema_version: z.literal(1).default(1),
  privacy: z.object({
    network_policy: z.enum(["loopback-only", "unrestricted"]).default("loopback-only"),
    store_raw_source: z.boolean().default(false),
    telemetry: z.literal(false).default(false),
    analytics: z.literal(false).default(false),
    query_logging: z.literal(false).default(false),
  }).default({}),
  embeddings: z.object({
    enabled: z.boolean().default(true),
    provider: z.enum(["ollama", "llamacpp"]).default("ollama"),
    base_url: z.string().url().default("http://127.0.0.1:11434"),
    model: z.string().min(1).default("qwen3-embedding:4b"),
    timeout_ms: z.number().int().min(100).max(600_000).default(60_000),
    batch_max_texts: z.number().int().min(1).max(32).default(32),
    batch_max_tokens_estimate: z.number().int().min(100).max(1_000_000).default(7_000),
  }).default({}),
  graphify: z.object({
    enabled: z.boolean().default(false),
    command: z.string().default("graphify"),
    timeout_ms: z.number().int().min(100).max(600_000).default(10_000),
  }).default({}),
  serena: z.object({
    enabled: z.boolean().default(false),
    command: z.string().default("serena"),
    timeout_ms: z.number().int().min(100).max(600_000).default(10_000),
  }).default({}),
  local_docs: z.object({
    enabled: z.boolean().default(false),
    transport: z.enum(["stdio", "http"]).default("stdio"),
    command: z.string().min(1).default("local-docs"),
    url: z.string().url().default("http://127.0.0.1:8000/mcp"),
    timeout_ms: z.number().int().min(100).max(600_000).default(7_000),
    search_tool: z.string().default("docs.search"),
    inspect_tool: z.string().min(1).optional(),
  }).default({}),
  vault: z.object({
    enabled: z.boolean().default(false),
    transport: z.enum(["stdio", "http"]).default("stdio"),
    command: z.string().min(1).default("vault-retrieval"),
    url: z.string().url().default("http://127.0.0.1:8123/mcp"),
    timeout_ms: z.number().int().min(100).max(600_000).default(7_000),
    token_file: z.string().min(1).optional(),
    search_tool: z.string().default("search"),
    inspect_tool: z.string().default("read_note"),
  }).default({}),
  limits: z.object({
    read_default_lines: z.number().int().min(1).max(400).default(200),
    read_max_lines: z.number().int().min(1).max(2000).default(400),
    output_max_bytes: z.number().int().min(1000).max(1_000_000).default(16_000),
  }).default({}),
  workspaces: z.array(workspaceSchema).default([]),
});

export type CodeIntelligenceConfig = z.infer<typeof configSchema>;
export type Workspace = z.infer<typeof workspaceSchema>;
export type Repository = z.infer<typeof repositorySchema>;

export const defaultConfig = (): CodeIntelligenceConfig => configSchema.parse({});
