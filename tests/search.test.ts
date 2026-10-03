import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { lexicalSearch } from "../src/search/lexical.js";
import { readCode } from "../src/search/read.js";
import { SemanticIndex } from "../src/search/semantic.js";
import { defaultConfig } from "../src/config/schema.js";
import { fixture, isolated } from "./helpers.js";
import { estimateEmbeddingTokens, safeIndividualEmbeddingBudget } from "../src/search/embedding-inputs.js";
import { sourceHash } from "../src/search/files.js";

test("multi-repo lexical search is scoped and never surfaces ignored secrets", async () => {
  const repos = [{ id: "backend", path: fixture("backend") }, { id: "shared", path: fixture("shared") }];
  const before = await Promise.all([readFile(path.join(repos[0]!.path, "src/PlanningService.ts"), "utf8"), readFile(path.join(repos[1]!.path, "src/duration.ts"), "utf8")]);
  const all = await lexicalSearch(repos, "Math.round", 20);
  assert.ok(all.some((item) => item.repo === "backend")); assert.ok(all.some((item) => item.repo === "shared"));
  assert.equal((await lexicalSearch(repos, "SHOULD_NEVER_BE_RETURNED", 20)).length, 0);
  assert.ok((await lexicalSearch([repos[0]!], "Math.round", 20)).every((item) => item.repo === "backend"));
  const after = await Promise.all([readFile(path.join(repos[0]!.path, "src/PlanningService.ts"), "utf8"), readFile(path.join(repos[1]!.path, "src/duration.ts"), "utf8")]);
  assert.deepEqual(after, before, "retrieval must not modify repository files");
});

test("exact reads reject traversal, secrets, and symlink escape", async () => {
  const env = await isolated("read-boundary");
  try {
    const outside = path.join(env.root, "outside.txt"); await writeFile(outside, "outside");
    const link = path.join(fixture("backend"), "escape-test-link"); await symlink(outside, link);
    try {
      await assert.rejects(readCode({ id: "backend", path: fixture("backend") }, "../shared/src/duration.ts"), /escapes/);
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

    const metadataFile = path.join(env.data, "indexes", repository.id, "semantic-metadata.jsonl");
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
    assert.deepEqual(flattenedInputs, textsFromRanges, "embedding input order must follow source line order");
    assert.deepEqual(firstMetadata.map((item) => item.hash), flattenedInputs.map(sourceHash));
    assert.ok(firstMetadata.every((item) => /^[a-f0-9]{64}$/.test(item.chunk_id)));

    const requestsAfterFirstRun = requestInputs.length;
    const second = await semantic.index(repository);
    assert.equal(second.reused, first.chunks);
    assert.equal(requestInputs.length, requestsAfterFirstRun, "fully reused split chunks must not call the provider");
    const secondMetadata = (await readFile(metadataFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(secondMetadata, firstMetadata, "split chunk IDs and hashes must be deterministic");
  } finally { await env.cleanup(); }
});
