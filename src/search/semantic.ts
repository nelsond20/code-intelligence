import path from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import crypto from "node:crypto";
import type { CodeIntelligenceConfig, Repository } from "../config/schema.js";
import { assertEndpointAllowed } from "../privacy/network-policy.js";
import { appPaths } from "../workspace/paths.js";
import { atomicWrite, readTextIfExists } from "../shared/fs.js";
import { chunkSource } from "./chunker.js";
import { readTextSource, sourceHash, walkSourceFiles } from "./files.js";
import { embeddingChunkIdentity, estimateEmbeddingTokens, safeIndividualEmbeddingBudget, splitEmbeddingChunk } from "./embedding-inputs.js";
import type { SearchResult } from "./types.js";
import { RepositoryAccessPolicy } from "../privacy/repository-access.js";
import { languageForPath, parseSymbols } from "../symbols/parser.js";

interface VectorMetadata { repo: string; path: string; start_line: number; end_line: number; hash: string; file_hash?: string; chunk_id?: string; symbol?: string; }
interface StoredIndex { schema_version: 2; provider?: "ollama" | "llamacpp"; model: string; dimensions: number; vectors: number[][]; }
interface IndexManifest { schema_version: 2; workspace: string; repo: string; root_fingerprint: string; generation: string; provider: string; model: string; dimensions: number; vectors: number; created_at: string; }
export type Embedder = (texts: string[]) => Promise<number[][]>;
export type IndexProgress =
  | { phase: "scanning" }
  | { phase: "embedding"; completed: number; total: number; reused: number; files: number; elapsed_ms: number }
  | { phase: "complete"; completed: number; total: number; reused: number; files: number; elapsed_ms: number };
export type IndexProgressCallback = (progress: IndexProgress) => void;
const MAX_EMBEDDING_BATCH_TEXTS = 32;

function buildLlamaCppBatches(texts: string[], maxTexts: number, maxTokensEstimate: number): string[][] {
  const batches: string[][] = [];
  let batch: string[] = [];
  let batchTokens = 0;
  for (const [index, text] of texts.entries()) {
    const estimatedTokens = estimateEmbeddingTokens(text);
    if (estimatedTokens > maxTokensEstimate) {
      throw new Error(`llama.cpp embedding input ${index} is estimated at ${estimatedTokens} tokens, exceeding batch_max_tokens_estimate=${maxTokensEstimate}`);
    }
    if (batch.length > 0 && (batch.length >= maxTexts || batchTokens + estimatedTokens > maxTokensEstimate)) {
      batches.push(batch); batch = []; batchTokens = 0;
    }
    batch.push(text); batchTokens += estimatedTokens;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, aa = 0, bb = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) { dot += a[i]! * b[i]!; aa += a[i]! ** 2; bb += b[i]! ** 2; }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}

export class SemanticIndex {
  constructor(private readonly config: CodeIntelligenceConfig, private readonly root = appPaths().indexDir, private readonly fetcher: typeof fetch = fetch,
    private readonly workspaceId = "default") {}

  private paths(repository: Repository, generation?: string) {
    const fingerprint = crypto.createHash("sha256").update(path.resolve(repository.path)).digest("hex").slice(0, 16);
    const root = path.join(this.root, this.workspaceId, repository.id, fingerprint);
    const generationRoot = generation ? path.join(root, "generations", generation) : undefined;
    return { root, fingerprint, manifest: path.join(root, "current.json"),
      metadata: generationRoot && path.join(generationRoot, "semantic-metadata.jsonl"),
      vectors: generationRoot && path.join(generationRoot, "semantic-vectors.bin") };
  }

  private async manifest(repository: Repository): Promise<IndexManifest | undefined> {
    const raw = await readTextIfExists(this.paths(repository).manifest);
    if (!raw) return undefined;
    const value = JSON.parse(raw) as IndexManifest;
    if (value.schema_version !== 2 || value.workspace !== this.workspaceId || value.repo !== repository.id
      || value.root_fingerprint !== this.paths(repository).fingerprint) throw new Error(`Semantic index identity mismatch for ${repository.id}`);
    return value;
  }

  embedder(): Embedder {
    const endpoint = assertEndpointAllowed(this.config.embeddings.base_url, this.config.privacy.network_policy);
    if (this.config.embeddings.provider === "llamacpp") return async (texts) => {
      const batches = buildLlamaCppBatches(texts, Math.min(MAX_EMBEDDING_BATCH_TEXTS, this.config.embeddings.batch_max_texts),
        this.config.embeddings.batch_max_tokens_estimate);
      const output: number[][] = [];
      for (const batch of batches) {
        const response = await this.fetcher(new URL("/v1/embeddings", endpoint), {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: this.config.embeddings.model, input: batch, encoding_format: "float" }),
          signal: AbortSignal.timeout(this.config.embeddings.timeout_ms),
        });
        if (!response.ok) throw new Error(`llama.cpp embedding request failed: HTTP ${response.status}`);
        const payload = await response.json() as { data?: Array<{ embedding?: number[]; index?: number }> };
        if (!Array.isArray(payload.data) || payload.data.length !== batch.length) throw new Error("Invalid llama.cpp embedding response");
        let ordered = payload.data;
        const hasAnyIndex = payload.data.some((item) => item.index !== undefined);
        const hasAllIndexes = payload.data.every((item) => Number.isInteger(item.index));
        if (hasAnyIndex && !hasAllIndexes) throw new Error("Invalid llama.cpp embedding response");
        if (hasAllIndexes) {
          const indexes = payload.data.map((item) => item.index!);
          if (new Set(indexes).size !== batch.length || indexes.some((index) => index < 0 || index >= batch.length)) {
            throw new Error("Invalid llama.cpp embedding response");
          }
          ordered = [...payload.data].sort((a, b) => a.index! - b.index!);
        }
        const embeddings = ordered.map((item) => item.embedding);
        if (embeddings.some((embedding) => !Array.isArray(embedding) || embedding.some((value) => typeof value !== "number"))) {
          throw new Error("Invalid llama.cpp embedding response");
        }
        output.push(...embeddings as number[][]);
      }
      return output;
    };
    return async (texts) => {
      const response = await this.fetcher(new URL("/api/embed", endpoint), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: this.config.embeddings.model, input: texts }), signal: AbortSignal.timeout(this.config.embeddings.timeout_ms),
      });
      if (!response.ok) throw new Error(`Ollama embedding request failed: HTTP ${response.status}`);
      const payload = await response.json() as { embeddings?: number[][] };
      if (!Array.isArray(payload.embeddings) || payload.embeddings.length !== texts.length) throw new Error("Invalid Ollama embedding response");
      return payload.embeddings;
    };
  }

  async index(repository: Repository, force = false, customEmbedder?: Embedder, onProgress?: IndexProgressCallback): Promise<{ chunks: number; files: number; reused: number }> {
    onProgress?.({ phase: "scanning" });
    const base = this.paths(repository);
    const previousManifest = force ? undefined : await this.manifest(repository);
    await mkdir(base.root, { recursive: true, mode: 0o700 });
    const previousMetadata = force ? [] : await this.readMetadata(repository);
    const previousIndex = force ? undefined : await this.readVectors(repository);
    const previousProvider = previousIndex?.provider || "ollama";
    const canReuse = previousIndex?.model === this.config.embeddings.model && previousProvider === this.config.embeddings.provider;
    const metadataKey = (meta: VectorMetadata) => meta.chunk_id || `${meta.path}:${meta.start_line}:${meta.end_line}:${meta.hash}`;
    const reusable = new Map(previousMetadata.map((meta, index) => [metadataKey(meta), canReuse ? previousIndex?.vectors[index] : undefined]));
    const metadata: VectorMetadata[] = [];
    const vectors: number[][] = [];
    const pending: { metadata: VectorMetadata; text: string }[] = [];
    let reused = 0;
    const files = await walkSourceFiles(repository.path);
    for (const relative of files) {
      const source = await readTextSource(path.join(repository.path, relative));
      if (source === undefined) continue;
      const fileHash = sourceHash(source);
      const occurrences = new Map<string, number>();
      const symbols = parseSymbols(source);
      for (const chunk of chunkSource(source, 80, 12, symbols)) {
        const chunks = this.config.embeddings.provider === "llamacpp"
          ? splitEmbeddingChunk(chunk, Math.max(256, safeIndividualEmbeddingBudget(this.config.embeddings.batch_max_tokens_estimate) - 512))
          : [chunk];
        for (const embeddingChunk of chunks) {
          let item: VectorMetadata;
          if (this.config.embeddings.provider === "llamacpp") {
            const contentHash = sourceHash(embeddingChunk.text);
            const occurrenceKey = `${embeddingChunk.start_line}:${embeddingChunk.end_line}:${contentHash}`;
            const occurrence = occurrences.get(occurrenceKey) || 0;
            occurrences.set(occurrenceKey, occurrence + 1);
            const identity = embeddingChunkIdentity(relative, embeddingChunk, occurrence);
            item = { repo: repository.id, path: relative, start_line: embeddingChunk.start_line,
              end_line: embeddingChunk.end_line, hash: identity.hash, file_hash: fileHash, chunk_id: identity.chunk_id, symbol: embeddingChunk.symbol };
          } else {
            item = { repo: repository.id, path: relative, start_line: embeddingChunk.start_line,
              end_line: embeddingChunk.end_line, hash: fileHash, file_hash: fileHash, symbol: embeddingChunk.symbol };
          }
          const old = reusable.get(metadataKey(item));
          if (old) { metadata.push(item); vectors.push(old); reused++; }
          else {
            const header = [`repo: ${repository.id}`, `path: ${relative}`, `language: ${languageForPath(relative)}`,
              embeddingChunk.symbol ? `symbol: ${embeddingChunk.symbol}` : "", embeddingChunk.signature ? `signature: ${embeddingChunk.signature}` : ""].filter(Boolean).join("\n");
            pending.push({ metadata: item, text: `${header}\n\n${embeddingChunk.text}` });
          }
        }
      }
    }
    const runEmbed = customEmbedder || this.embedder();
    const startedAt = performance.now();
    onProgress?.({ phase: "embedding", completed: 0, total: pending.length, reused, files: files.length, elapsed_ms: 0 });
    const batchMaxTexts = Math.min(MAX_EMBEDDING_BATCH_TEXTS, this.config.embeddings.batch_max_texts);
    for (let offset = 0; offset < pending.length; offset += batchMaxTexts) {
      const batch = pending.slice(offset, offset + batchMaxTexts);
      const embedded = await runEmbed(batch.map((item) => item.text));
      batch.forEach((item, index) => { metadata.push(item.metadata); vectors.push(embedded[index]!); });
      onProgress?.({ phase: "embedding", completed: Math.min(offset + batch.length, pending.length), total: pending.length,
        reused, files: files.length, elapsed_ms: performance.now() - startedAt });
    }
    const dimensions = vectors[0]?.length || 0;
    if (vectors.some((vector) => vector.length !== dimensions)) throw new Error("Embedding provider returned inconsistent vector dimensions");
    const generation = `${Date.now().toString(36)}-${crypto.randomBytes(6).toString("hex")}`;
    const next = this.paths(repository, generation);
    await mkdir(path.dirname(next.metadata!), { recursive: true, mode: 0o700 });
    await atomicWrite(next.metadata!, metadata.map((item) => JSON.stringify(item)).join("\n") + (metadata.length ? "\n" : ""));
    await atomicWrite(next.vectors!, JSON.stringify({ schema_version: 2, provider: this.config.embeddings.provider,
      model: this.config.embeddings.model, dimensions, vectors } satisfies StoredIndex));
    await atomicWrite(base.manifest, `${JSON.stringify({ schema_version: 2, workspace: this.workspaceId, repo: repository.id,
      root_fingerprint: base.fingerprint, generation, provider: this.config.embeddings.provider, model: this.config.embeddings.model,
      dimensions, vectors: vectors.length, created_at: new Date().toISOString() } satisfies IndexManifest, null, 2)}\n`);
    onProgress?.({ phase: "complete", completed: pending.length, total: pending.length, reused,
      files: files.length, elapsed_ms: performance.now() - startedAt });
    return { chunks: metadata.length, files: files.length, reused };
  }

  async search(repositories: Repository[], query: string, limit: number, customEmbedder?: Embedder): Promise<SearchResult[]> {
    const [queryVector] = await (customEmbedder || this.embedder())([query]);
    if (!queryVector) throw new Error("Embedding provider returned no query vector");
    const scored: { metadata: VectorMetadata; score: number; repository: Repository }[] = [];
    for (const repository of repositories) {
      const metadata = await this.readMetadata(repository);
      const index = await this.readVectors(repository);
      if (!index) continue;
      if (metadata.length !== index.vectors.length || index.vectors.some((vector) => vector.length !== index.dimensions)) throw new Error(`Semantic index is inconsistent for ${repository.id}`);
      metadata.forEach((item, position) => scored.push({ metadata: item, score: cosine(queryVector, index.vectors[position] || []), repository }));
    }
    const output: SearchResult[] = [];
    for (const item of scored.sort((a, b) => b.score - a.score).slice(0, limit)) {
      const policy = await RepositoryAccessPolicy.create(item.repository.path);
      if (!policy.canRead(item.metadata.path)) continue;
      const resolved = await policy.resolveFile(item.metadata.path);
      const source = await readFile(resolved.absolute, "utf8");
      if (item.metadata.file_hash && sourceHash(source) !== item.metadata.file_hash) continue;
      const lines = source.split(/\r?\n/);
      output.push({ repo: item.metadata.repo, path: item.metadata.path, start_line: item.metadata.start_line, end_line: item.metadata.end_line,
        snippet: lines.slice(item.metadata.start_line - 1, Math.min(item.metadata.end_line, item.metadata.start_line + 12)).join("\n").slice(0, 1200),
        reason: "semantic similarity", semantic_score: item.score, score: item.score, symbol: item.metadata.symbol });
    }
    return output;
  }

  async status(repository: Repository): Promise<"fresh" | "partial" | "stale" | "missing"> {
    const manifest = await this.manifest(repository);
    if (!manifest) return "missing";
    const metadata = await this.readMetadata(repository); let stale = 0;
    const byFile = new Map<string, string>();
    for (const item of metadata) if (item.file_hash) byFile.set(item.path, item.file_hash);
    const policy = await RepositoryAccessPolicy.create(repository.path);
    for (const [relative, hash] of byFile) {
      try {
        if (!policy.canRead(relative) || sourceHash(await readFile((await policy.resolveFile(relative)).absolute, "utf8")) !== hash) stale++;
      } catch { stale++; }
    }
    return stale === 0 ? "fresh" : stale === byFile.size ? "stale" : "partial";
  }

  private async readMetadata(repository: Repository): Promise<VectorMetadata[]> {
    const manifest = await this.manifest(repository); if (!manifest) return [];
    const raw = await readTextIfExists(this.paths(repository, manifest.generation).metadata!);
    if (!raw) return [];
    return raw.trim().split(/\r?\n/).filter(Boolean).map((line) => {
      const value = JSON.parse(line) as VectorMetadata;
      if (!value.path || !Number.isInteger(value.start_line) || !Number.isInteger(value.end_line) || !value.hash) throw new Error("Invalid semantic metadata");
      return value;
    });
  }
  private async readVectors(repository: Repository): Promise<StoredIndex | undefined> {
    const manifest = await this.manifest(repository); if (!manifest) return undefined;
    const raw = await readTextIfExists(this.paths(repository, manifest.generation).vectors!);
    if (!raw) return undefined;
    const value = JSON.parse(raw) as StoredIndex;
    if (value.schema_version !== 2 || !Array.isArray(value.vectors) || !Number.isInteger(value.dimensions)) throw new Error("Invalid semantic vector index");
    return value;
  }
}
