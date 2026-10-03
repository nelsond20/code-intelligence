import path from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import type { CodeIntelligenceConfig, Repository } from "../config/schema.js";
import { assertEndpointAllowed } from "../privacy/network-policy.js";
import { appPaths } from "../workspace/paths.js";
import { atomicWrite, readTextIfExists } from "../shared/fs.js";
import { chunkSource } from "./chunker.js";
import { readTextSource, sourceHash, walkSourceFiles } from "./files.js";
import { embeddingChunkIdentity, estimateEmbeddingTokens, safeIndividualEmbeddingBudget, splitEmbeddingChunk } from "./embedding-inputs.js";
import type { SearchResult } from "./types.js";

interface VectorMetadata { repo: string; path: string; start_line: number; end_line: number; hash: string; chunk_id?: string; }
interface StoredIndex { schema_version: 1; provider?: "ollama" | "llamacpp"; model: string; dimensions: number; vectors: number[][]; }
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
  constructor(private readonly config: CodeIntelligenceConfig, private readonly root = appPaths().indexDir, private readonly fetcher: typeof fetch = fetch) {}

  private paths(repositoryId: string) {
    const root = path.join(this.root, repositoryId);
    return { root, metadata: path.join(root, "semantic-metadata.jsonl"), vectors: path.join(root, "semantic-vectors.bin") };
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
    const locations = this.paths(repository.id);
    await mkdir(locations.root, { recursive: true, mode: 0o700 });
    const previousMetadata = force ? [] : await this.readMetadata(repository.id);
    const previousIndex = force ? undefined : await this.readVectors(repository.id);
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
      for (const chunk of chunkSource(source)) {
        const chunks = this.config.embeddings.provider === "llamacpp"
          ? splitEmbeddingChunk(chunk, safeIndividualEmbeddingBudget(this.config.embeddings.batch_max_tokens_estimate))
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
              end_line: embeddingChunk.end_line, hash: identity.hash, chunk_id: identity.chunk_id };
          } else {
            item = { repo: repository.id, path: relative, start_line: embeddingChunk.start_line,
              end_line: embeddingChunk.end_line, hash: fileHash };
          }
          const old = reusable.get(metadataKey(item));
          if (old) { metadata.push(item); vectors.push(old); reused++; }
          else pending.push({ metadata: item, text: embeddingChunk.text });
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
    await atomicWrite(locations.metadata, metadata.map((item) => JSON.stringify(item)).join("\n") + (metadata.length ? "\n" : ""));
    await atomicWrite(locations.vectors, JSON.stringify({ schema_version: 1, provider: this.config.embeddings.provider,
      model: this.config.embeddings.model, dimensions, vectors } satisfies StoredIndex));
    onProgress?.({ phase: "complete", completed: pending.length, total: pending.length, reused,
      files: files.length, elapsed_ms: performance.now() - startedAt });
    return { chunks: metadata.length, files: files.length, reused };
  }

  async search(repositories: Repository[], query: string, limit: number, customEmbedder?: Embedder): Promise<SearchResult[]> {
    const [queryVector] = await (customEmbedder || this.embedder())([query]);
    if (!queryVector) throw new Error("Embedding provider returned no query vector");
    const scored: { metadata: VectorMetadata; score: number; repository: Repository }[] = [];
    for (const repository of repositories) {
      const metadata = await this.readMetadata(repository.id);
      const index = await this.readVectors(repository.id);
      if (!index) continue;
      metadata.forEach((item, position) => scored.push({ metadata: item, score: cosine(queryVector, index.vectors[position] || []), repository }));
    }
    const output: SearchResult[] = [];
    for (const item of scored.sort((a, b) => b.score - a.score).slice(0, limit)) {
      const source = await readFile(path.join(item.repository.path, item.metadata.path), "utf8");
      const lines = source.split(/\r?\n/);
      output.push({ repo: item.metadata.repo, path: item.metadata.path, start_line: item.metadata.start_line, end_line: item.metadata.end_line,
        snippet: lines.slice(item.metadata.start_line - 1, Math.min(item.metadata.end_line, item.metadata.start_line + 12)).join("\n").slice(0, 1200),
        reason: "semantic similarity", semantic_score: item.score, score: item.score });
    }
    return output;
  }

  private async readMetadata(repositoryId: string): Promise<VectorMetadata[]> {
    const raw = await readTextIfExists(this.paths(repositoryId).metadata);
    if (!raw) return [];
    return raw.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as VectorMetadata);
  }
  private async readVectors(repositoryId: string): Promise<StoredIndex | undefined> {
    const raw = await readTextIfExists(this.paths(repositoryId).vectors);
    return raw ? JSON.parse(raw) as StoredIndex : undefined;
  }
}
