import crypto from "node:crypto";
import type { SourceChunk } from "./chunker.js";

const SPECIAL_TOKEN_HEADROOM = 2;
const INDIVIDUAL_INPUT_SAFETY_RATIO = 0.9;

// llama.cpp's exact model tokenizer is not available locally. UTF-8 bytes plus special-token
// headroom is a conservative upper estimate for the byte-level BPE tokenizers it serves.
export function estimateEmbeddingTokens(text: string): number {
  return Math.max(1, Buffer.byteLength(text, "utf8")) + SPECIAL_TOKEN_HEADROOM;
}

export function safeIndividualEmbeddingBudget(batchBudget: number): number {
  return Math.max(SPECIAL_TOKEN_HEADROOM + 1, Math.floor(batchBudget * INDIVIDUAL_INPUT_SAFETY_RATIO));
}

function sourceBoundary(line: string): boolean {
  return /^\s*(?:(?:export|public|private|protected|static|abstract|async)\s+)*(?:class|interface|enum|function|def)\b/.test(line)
    || /^\s*(?:(?:public|private|protected|static|async)\s+)*[A-Za-z_$][\w$]*\s*\([^)]*\)\s*(?:\{|=>|:)/.test(line);
}

function splitOversizedLine(text: string, line: number, budget: number): SourceChunk[] {
  const maxBytes = budget - SPECIAL_TOKEN_HEADROOM;
  const output: SourceChunk[] = [];
  let pending: string[] = [];
  let pendingBytes = 0;
  let whitespaceCut = 0;

  const flush = (cut: number) => {
    const value = pending.slice(0, cut).join("");
    if (value) output.push({ start_line: line, end_line: line, text: value });
    pending = pending.slice(cut);
    pendingBytes = Buffer.byteLength(pending.join(""), "utf8");
    whitespaceCut = 0;
    pending.forEach((character, index) => { if (/\s/u.test(character)) whitespaceCut = index + 1; });
  };

  for (const character of text) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (pending.length > 0 && pendingBytes + bytes > maxBytes) flush(whitespaceCut || pending.length);
    if (bytes > maxBytes) throw new Error(`Cannot split Unicode code point on source line ${line} within embedding budget ${budget}`);
    pending.push(character); pendingBytes += bytes;
    if (/\s/u.test(character)) whitespaceCut = pending.length;
  }
  if (pending.length > 0) flush(pending.length);
  return output;
}

export function splitEmbeddingChunk(chunk: SourceChunk, budget: number): SourceChunk[] {
  if (estimateEmbeddingTokens(chunk.text) <= budget) return [chunk];
  const lines = chunk.text.split(/\r?\n/);
  const output: SourceChunk[] = [];
  let start = 0;

  while (start < lines.length) {
    if (estimateEmbeddingTokens(lines[start]!) > budget) {
      output.push(...splitOversizedLine(lines[start]!, chunk.start_line + start, budget));
      start++;
      continue;
    }

    let end = start + 1;
    while (end < lines.length && estimateEmbeddingTokens(lines.slice(start, end + 1).join("\n")) <= budget) end++;
    if (end < lines.length) {
      const preferredCuts: number[] = [];
      for (let cut = start + 1; cut < end; cut++) {
        if (lines[cut - 1]!.trim() === "" || sourceBoundary(lines[cut]!)) preferredCuts.push(cut);
      }
      const substantial = preferredCuts.filter((cut) =>
        estimateEmbeddingTokens(lines.slice(start, cut).join("\n")) >= Math.floor(budget / 2));
      if (substantial.length > 0) end = substantial.at(-1)!;
    }
    const text = lines.slice(start, end).join("\n");
    output.push({ start_line: chunk.start_line + start, end_line: chunk.start_line + end - 1, text, symbol: chunk.symbol, signature: chunk.signature });
    start = end;
  }
  return output;
}

export function embeddingChunkIdentity(repositoryPath: string, chunk: SourceChunk, occurrence: number): { chunk_id: string; hash: string } {
  const hash = crypto.createHash("sha256").update(chunk.text).digest("hex");
  const identity = `${repositoryPath}\0${chunk.start_line}\0${chunk.end_line}\0${hash}\0${occurrence}`;
  return { chunk_id: crypto.createHash("sha256").update(identity).digest("hex"), hash };
}
