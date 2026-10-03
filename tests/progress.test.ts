import test from "node:test";
import assert from "node:assert/strict";
import { formatIndexProgress, IndexProgressRenderer } from "../src/cli/progress.js";

test("index progress includes a bar, speed, ETA, and reused chunks", () => {
  const line = formatIndexProgress("backend", { phase: "embedding", completed: 50, total: 100, reused: 25, files: 10, elapsed_ms: 5_000 }, 10);
  assert.match(line, /\[#####-----\]/);
  assert.match(line, /50% 50\/100 new/);
  assert.match(line, /10\.0 chunks\/s/);
  assert.match(line, /ETA 00:05/);
  assert.match(line, /25 reused/);
});

test("progress renderer keeps machine-readable output separate and finishes its TTY line", () => {
  let output = "";
  const stream = { isTTY: true, columns: 100, write(value: string) { output += value; return true; } };
  const renderer = new IndexProgressRenderer(stream as NodeJS.WriteStream, () => 1_000);
  renderer.render("backend", { phase: "complete", completed: 4, total: 4, reused: 2, files: 3, elapsed_ms: 1_000 });
  assert.match(output, /^\r\x1b\[2K/);
  assert.match(output, /100% 4\/4 new.*done.*2 reused\n$/);
});
