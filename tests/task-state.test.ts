import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { TaskService } from "../src/task-state/service.js";
import { TaskStorage } from "../src/task-state/storage.js";
import { isolated } from "./helpers.js";

test("memory lifecycle, semantic notes, legacy migration, spec, and bounded compaction context", async () => {
  const env = await isolated("tasks");
  try {
    const storage = new TaskStorage(path.join(env.data, "workspaces")); const service = new TaskService(storage);
    const first = await service.create("planning", "Duration fix", { objective: "Correct duration" });
    await service.note("planning", { type: "hypothesis", text: "Rounding is wrong", confidence: "medium", repo: "backend", file: "src/PlanningService.ts", symbol: "PlanningService.calculateDuration" });
    await service.recordInspection("planning", { ref: "code://backend/src/PlanningService.ts#L=1-3", repo: "backend", files: ["src/PlanningService.ts"] });
    await service.note("planning", { type: "evidence", text: "The service uses Math.round", evidence_refs: ["code://backend/src/PlanningService.ts#L=1-3"] });
    await service.update("planning", undefined, { phase: "design", spec: "Duration uses exact millisecond arithmetic." });
    const statePath = storage.statePath("planning", first.id);
    const legacy = JSON.parse(await readFile(statePath, "utf8"));
    legacy.current_focus = "Inspect rounding"; legacy.next_actions = ["Read tests"];
    await writeFile(statePath, `${JSON.stringify(legacy, null, 2)}\n`);
    const restarted = new TaskService(new TaskStorage(path.join(env.data, "workspaces")));
    const current = await restarted.current("planning");
    assert.equal(current?.id, first.id); assert.equal(current?.active_hypotheses.length, 1);
    assert.equal(current?.confirmed_findings.length, 0); assert.equal(current?.supported_findings.length, 1);
    assert.equal(Object.hasOwn(current || {}, "current_focus"), false); assert.equal(Object.hasOwn(current || {}, "next_actions"), false);
    assert.match(await restarted.storage.readSpec("planning", first.id), /R1.*Duration uses exact millisecond arithmetic/);
    await restarted.recordInspection("planning", { ref: "git://backend/commit/abcdef1", repo: "backend", commit: "abcdef1", files: ["src/PlanningService.ts"], symbols: ["calculateDuration"] });
    const recorded = await restarted.current("planning");
    assert.deepEqual(recorded?.inspected_commits, [{ repo: "backend", commit: "abcdef1" }]);
    assert.equal(recorded?.active_hypotheses.length, 1, "mechanical inspection must not add semantic conclusions");
    const compact = await restarted.context("planning", 200); assert.ok(compact.length <= 800); assert.doesNotMatch(compact, /Inspect rounding|Read tests|findings\.md|spec\.md/);
    await restarted.transition("planning", "paused"); assert.equal(await restarted.current("planning"), undefined);
    await restarted.activate("planning", first.id); await restarted.transition("planning", "completed");
    assert.equal((await restarted.list("planning"))[0]?.status, "completed");
  } finally { await env.cleanup(); }
});
