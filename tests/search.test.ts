import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { lexicalSearch } from "../src/search/lexical.js";
import { readCode } from "../src/search/read.js";
import { SemanticIndex } from "../src/search/semantic.js";
import { defaultConfig } from "../src/config/schema.js";
import { fixture, isolated } from "./helpers.js";
import { estimateEmbeddingTokens, safeIndividualEmbeddingBudget } from "../src/search/embedding-inputs.js";
import { sourceHash, walkSourceFiles } from "../src/search/files.js";
import { containingSymbol, parseSymbols, structuralParserForPath } from "../src/symbols/parser.js";
import { chunkSource } from "../src/search/chunker.js";

test("ast-grep extracts exact nested TypeScript symbols and keeps multilingual fallback", () => {
  const source = [
    "export class Service {",
    "  async run(input: string): Promise<number> {",
    "    const inner = () => input.length;",
    "    return inner();",
    "  }",
    "  handler = () => true;",
    "}",
    "export function top(value: string): string;",
    "export function top(value: number) {",
    "  return value;",
    "}",
  ].join("\n");
  assert.equal(structuralParserForPath("service.ts"), "ast-grep");
  const symbols = parseSymbols(source, "service.ts");
  assert.deepEqual(symbols.map((item) => [item.qualified_name, item.start_line, item.end_line]), [
    ["Service", 1, 7],
    ["Service.run", 2, 5],
    ["Service.run.inner", 3, 3],
    ["Service.handler", 6, 6],
    ["top", 8, 8],
    ["top", 9, 11],
  ]);
  assert.equal(containingSymbol(symbols, 4)?.qualified_name, "Service.run");
  assert.doesNotMatch(symbols.find((item) => item.qualified_name === "Service.run")!.signature, /return inner/);
  const chunks = chunkSource(source, 80, 12, symbols);
  assert.deepEqual(chunks.map((item) => [item.start_line, item.end_line, item.symbol]), [
    [1, 1, undefined],
    [2, 5, "Service.run"],
    [6, 6, "Service.handler"],
    [7, 7, undefined],
    [8, 8, "top"],
    [9, 11, "top"],
  ]);
  assert.equal(chunks.flatMap((item) => item.text.split("\n")).length, source.split("\n").length, "structural chunks must not duplicate or omit lines");
  const compactSource = "class Compact { method() { const nested = () => 1; return nested(); } }";
  const compactChunks = chunkSource(compactSource, 80, 12, parseSymbols(compactSource, "compact.ts"));
  assert.equal(compactChunks.length, 1);
  assert.equal(compactChunks[0]?.symbol, "Compact.method");

  const python = parseSymbols("class Worker:\n    def execute(self):\n        return True\n", "worker.py");
  assert.equal(structuralParserForPath("worker.py"), "local-fallback");
  assert.ok(python.some((item) => item.name === "Worker"));
  assert.ok(python.some((item) => item.name === "execute"));
});

test("multi-repo lexical search is scoped and never surfaces ignored secrets", async () => {
  const env = await isolated("lexical-scoped");
  try {
    const repos = [{ id: "backend", path: path.join(env.root, "backend") }, { id: "shared", path: path.join(env.root, "shared") }];
    await Promise.all(repos.map((repo) => cp(fixture(repo.id), repo.path, { recursive: true })));
    const before = await Promise.all([readFile(path.join(repos[0]!.path, "src/PlanningService.ts"), "utf8"), readFile(path.join(repos[1]!.path, "src/duration.ts"), "utf8")]);
    const all = await lexicalSearch(repos, "Math.round", 20);
    assert.ok(all.some((item) => item.repo === "backend")); assert.ok(all.some((item) => item.repo === "shared"));
    assert.equal((await lexicalSearch(repos, "SHOULD_NEVER_BE_RETURNED", 20)).length, 0);
    assert.ok((await lexicalSearch([repos[0]!], "Math.round", 20)).every((item) => item.repo === "backend"));
    const after = await Promise.all([readFile(path.join(repos[0]!.path, "src/PlanningService.ts"), "utf8"), readFile(path.join(repos[1]!.path, "src/duration.ts"), "utf8")]);
    assert.deepEqual(after, before, "retrieval must not modify repository files");
  } finally { await env.cleanup(); }
});

test("runtime files never enter lexical or semantic Code indexing", async () => {
  const env = await isolated("runtime-index-exclusion");
  try {
    const workspace = path.join(env.root, "workspace");
    const runtime = path.join(workspace, ".ci-runtime");
    await mkdir(path.join(runtime, "data"), { recursive: true });
    await writeFile(path.join(workspace, "sentinel.mjs"), "export const preflightSentinel = 1;\n");
    await writeFile(path.join(runtime, "config.toml"), "preflightSentinel internal config\n");
    await writeFile(path.join(runtime, "data", "state.json"), "preflightSentinel internal state\n");
    const repo = { id: "workspace", path: workspace };
    assert.deepEqual(await walkSourceFiles(workspace), ["sentinel.mjs"]);
    assert.deepEqual((await lexicalSearch([repo], "preflightSentinel", 20)).map((item) => item.path), ["sentinel.mjs"]);
    const config = defaultConfig(); config.embeddings.enabled = true;
    const inputs: string[] = [];
    const embed = async (texts: string[]) => texts.map((text) => { inputs.push(text); return [1, 0]; });
    const semantic = new SemanticIndex(config, path.join(env.data, "indexes"));
    const indexed = await semantic.index(repo, false, embed);
    assert.equal(indexed.files, 1);
    assert.ok(inputs.every((input) => !input.includes("internal config") && !input.includes("internal state")));
    assert.deepEqual((await semantic.search([repo], "preflightSentinel", 20, embed)).map((item) => item.path), ["sentinel.mjs"]);
    await assert.rejects(readCode(repo, ".ci-runtime/config.toml"), /excluded/);
  } finally { await env.cleanup(); }
});

test("legacy runtime vectors cannot crowd out live semantic results", async () => {
  const env = await isolated("legacy-runtime-index");
  try {
    const workspace = path.join(env.root, "workspace");
    await mkdir(path.join(workspace, ".ci-runtime"), { recursive: true });
    await writeFile(path.join(workspace, "sentinel.mjs"), "export const preflightSentinel = 1;\n");
    await writeFile(path.join(workspace, ".ci-runtime", "config.toml"), "preflightSentinel internal config\n");
    const repo = { id: "workspace", path: workspace };
    const config = defaultConfig(); config.embeddings.enabled = true;
    const embed = async (texts: string[]) => texts.map(() => [1, 0]);
    const semantic = new SemanticIndex(config, path.join(env.data, "indexes"));
    await semantic.index(repo, false, embed);
    const indexRoot = path.join(env.data, "indexes", "default", repo.id);
    const [fingerprint] = await (await import("node:fs/promises")).readdir(indexRoot);
    const current = JSON.parse(await readFile(path.join(indexRoot, fingerprint!, "current.json"), "utf8")) as { generation: string };
    const generation = path.join(indexRoot, fingerprint!, "generations", current.generation);
    const metadataPath = path.join(generation, "semantic-metadata.jsonl");
    const vectorPath = path.join(generation, "semantic-vectors.bin");
    const live = JSON.parse((await readFile(metadataPath, "utf8")).trim()) as { path: string };
    const legacy = { ...live, path: ".ci-runtime/config.toml" };
    await writeFile(metadataPath, `${JSON.stringify(legacy)}\n${JSON.stringify(live)}\n`);
    const vectors = JSON.parse(await readFile(vectorPath, "utf8")) as { vectors: number[][] };
    vectors.vectors.unshift([1, 0]);
    await writeFile(vectorPath, JSON.stringify(vectors));
    const results = await semantic.search([repo], "preflightSentinel", 1, embed);
    assert.deepEqual(results.map((item) => item.path), ["sentinel.mjs"]);
  } finally { await env.cleanup(); }
});

test("exact reads reject traversal, secrets, and symlink escape", async () => {
  const env = await isolated("read-boundary");
  try {
    const outside = path.join(env.root, "outside.txt"); await writeFile(outside, "outside");
    const link = path.join(fixture("backend"), "escape-test-link"); await symlink(outside, link);
    try {
      await assert.rejects(readCode({ id: "backend", path: fixture("backend") }, "../shared/src/duration.ts"), /escapes|excluded/);
      await assert.rejects(readCode({ id: "backend", path: fixture("backend") }, ".env.secret"), /excluded/);
      await assert.rejects(readCode({ id: "backend", path: fixture("backend") }, "escape-test-link"), /Symlink escapes/);
    } finally { const { rm } = await import("node:fs/promises"); await rm(link, { force: true }); }
  } finally { await env.cleanup(); }
});

test("semantic index stores metadata without source and supports mocked embeddings", async () => {
  const env = await isolated("semantic");
  try {
    const config = defaultConfig(); config.embeddings.enabled = true;
    const semantic = new SemanticIndex(config, path.join(env.data, "indexes"));
    const embed = async (texts: string[]) => texts.map((text) => [text.includes("duration") ? 1 : 0, text.length / 1000]);
    const repo = { id: "shared", path: fixture("shared") };
    const progress: string[] = [];
    const indexed = await semantic.index(repo, false, embed, (event) => progress.push(event.phase)); assert.ok(indexed.chunks > 0);
    assert.equal(progress[0], "scanning"); assert.equal(progress.at(-1), "complete"); assert.ok(progress.includes("embedding"));
    const results = await semantic.search([repo], "duration", 3, embed); assert.equal(results[0]?.repo, "shared");
    const indexRoot = path.join(env.data, "indexes", "default", repo.id);
    const [fingerprint] = await (await import("node:fs/promises")).readdir(indexRoot);
    const manifestPath = path.join(indexRoot, fingerprint!, "current.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { chunk_schema?: number };
    assert.equal(manifest.chunk_schema, 3);
    delete manifest.chunk_schema; await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    assert.equal(await semantic.status(repo), "stale");
    assert.deepEqual(await semantic.search([repo], "duration", 3, embed), []);
    assert.equal((await semantic.index(repo, false, embed)).reused, 0, "obsolete chunk schemas must be rebuilt, not reused");
  } finally { await env.cleanup(); }
});

test("oversized llamacpp chunks split safely with stable metadata and incremental reuse", async () => {
  const env = await isolated("llamacpp-oversized");
  try {
    const repositoryPath = path.join(env.root, "repository");
    await mkdir(repositoryPath);
    const sourceLines = Array.from({ length: 78 }, (_, index) => `${String(index).padStart(2, "0")}${"x".repeat(96)}`);
    const source = sourceLines.join("\n");
    assert.ok(estimateEmbeddingTokens(source) >= 7_700 && estimateEmbeddingTokens(source) <= 7_900);
    await writeFile(path.join(repositoryPath, "large.ts"), source);
    const config = defaultConfig();
    config.embeddings.enabled = true;
    config.embeddings.provider = "llamacpp";
    config.embeddings.base_url = "http://127.0.0.1:11435";
    config.embeddings.batch_max_texts = 32;
    config.embeddings.batch_max_tokens_estimate = 7_000;
    const requestInputs: string[][] = [];
    const fetcher = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      requestInputs.push(body.input);
      return new Response(JSON.stringify({ data: body.input.map((_text, index) => ({ index, embedding: [requestInputs.length, index] })) }), { status: 200 });
    }) as typeof fetch;
    const semantic = new SemanticIndex(config, path.join(env.data, "indexes"), fetcher);
    const repository = { id: "oversized", path: repositoryPath };
    const first = await semantic.index(repository);
    assert.ok(first.chunks > 1, "one oversized source chunk should become multiple embedding chunks");

    const flattenedInputs = requestInputs.flat();
    assert.equal(flattenedInputs.length, first.chunks);
    const individualBudget = safeIndividualEmbeddingBudget(config.embeddings.batch_max_tokens_estimate);
    assert.ok(flattenedInputs.every((text) => estimateEmbeddingTokens(text) <= individualBudget));
    assert.ok(requestInputs.every((batch) => batch.reduce((total, text) => total + estimateEmbeddingTokens(text), 0)
      <= config.embeddings.batch_max_tokens_estimate));
    assert.ok(requestInputs.length > 1, "aggregate batching must still run after chunk splitting");

    const indexRoot = path.join(env.data, "indexes", "default", repository.id);
    const [fingerprint] = await (await import("node:fs/promises")).readdir(indexRoot);
    const manifest = JSON.parse(await readFile(path.join(indexRoot, fingerprint!, "current.json"), "utf8")) as { generation: string };
    const metadataFile = path.join(indexRoot, fingerprint!, "generations", manifest.generation, "semantic-metadata.jsonl");
    const firstMetadata = (await readFile(metadataFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as {
      path: string; start_line: number; end_line: number; hash: string; chunk_id: string;
    });
    assert.equal(firstMetadata[0]?.path, "large.ts");
    assert.equal(firstMetadata[0]?.start_line, 1);
    assert.equal(firstMetadata.at(-1)?.end_line, sourceLines.length);
    for (let index = 1; index < firstMetadata.length; index++) {
      assert.equal(firstMetadata[index]!.start_line, firstMetadata[index - 1]!.end_line + 1);
    }
    const textsFromRanges = firstMetadata.map((item) => sourceLines.slice(item.start_line - 1, item.end_line).join("\n"));
    assert.deepEqual(flattenedInputs.map((text) => text.split("\n\n").at(-1)), textsFromRanges, "embedding input order must follow source line order");
    assert.deepEqual(firstMetadata.map((item) => item.hash), flattenedInputs.map((text) => sourceHash(text.split("\n\n").at(-1)!)));
    assert.ok(firstMetadata.every((item) => /^[a-f0-9]{64}$/.test(item.chunk_id)));

    const requestsAfterFirstRun = requestInputs.length;
    const second = await semantic.index(repository);
    assert.equal(second.reused, first.chunks);
    assert.equal(requestInputs.length, requestsAfterFirstRun, "fully reused split chunks must not call the provider");
    const secondMetadata = (await readFile(metadataFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(secondMetadata, firstMetadata, "split chunk IDs and hashes must be deterministic");
  } finally { await env.cleanup(); }
});
