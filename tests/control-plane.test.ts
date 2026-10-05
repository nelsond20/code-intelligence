import test from "node:test";
import assert from "node:assert/strict";
import { fixtureWorkspace } from "./helpers.js";
import { TaskService } from "../src/task-state/service.js";
import { MemoryControlService } from "../src/control/service.js";
import { controlRoute } from "../src/control/server.js";
import { controlPage } from "../src/control/page.js";
import { memoryInput, parseMemoryAction } from "../src/mcp/schemas.js";
import { PlanService } from "../src/plan/service.js";
import vm from "node:vm";

test("flat memory transport dispatches strict selected-action validation", () => {
  assert.deepEqual(memoryInput.shape.action.options, ["current", "note", "resolve", "spec_set"]);
  assert.deepEqual(parseMemoryAction({ action: "current" }), { action: "current" });
  assert.throws(() => parseMemoryAction({ action: "current", text: "wrong" }), /Unrecognized key/);
  assert.throws(() => parseMemoryAction({ action: "note", text: "missing type" }), /type/);
  assert.throws(() => parseMemoryAction({ action: "resolve", record_id: "M1", status: "confirmed" }), /reason/);
  assert.throws(() => parseMemoryAction({ action: "spec_set", summary: "Goal", requirements: [] }), /requirements/);
  assert.equal(memoryInput.safeParse({ action: "spec_set", summary: "Goal", requirements: [{ statement: "Must pass", kind: "constraint", priority: "must" }] }).success, true);
});

test("spec_set preserves IDs, computes one revision per change, rejects foreign IDs, and admin rollback is auditable", async () => {
  const env = await fixtureWorkspace("control-spec");
  try {
    const tasks = new TaskService();
    const first = await tasks.create("planning", "First");
    const created = await tasks.setSpec("planning", { summary: "Goal", requirements: [{ statement: "A", kind: "constraint", priority: "must" }] });
    assert.deepEqual(created.diff, { added: ["R1"], updated: [], removed: [] });
    assert.equal(created.spec.revision, 1);
    assert.equal((await tasks.setSpec("planning", { summary: "Goal", requirements: [{ id: "R1", statement: "A", kind: "constraint", priority: "must" }] })).changed, false);
    const updated = await tasks.setSpec("planning", { summary: "Goal", requirements: [
      { id: "R1", statement: "A revised", kind: "constraint", priority: "must" },
      { statement: "B", kind: "behavior", priority: "should" },
    ] });
    assert.equal(updated.spec.revision, 2);
    assert.deepEqual(updated.diff, { added: ["R2"], updated: ["R1"], removed: [] });
    await assert.rejects(tasks.setSpec("planning", { summary: "Goal", requirements: [
      { id: "R1", statement: "A", kind: "constraint", priority: "must" },
      { id: "R1", statement: "B", kind: "constraint", priority: "must" },
    ] }), /Duplicate requirement/);
    await assert.rejects(tasks.setSpec("planning", { summary: "Goal", requirements: [{ id: "R99", statement: "Foreign", kind: "constraint", priority: "must" }] }), /Unknown requirement/);
    const removed = await tasks.setSpec("planning", { summary: "Goal", requirements: [{ id: "R2", statement: "B", kind: "behavior", priority: "should" }] });
    assert.deepEqual(removed.diff.removed, ["R1"]);
    const control = new MemoryControlService();
    const restored = await control.rollback("planning", first.id, 1);
    assert.equal(restored.revision, 4);
    assert.match(restored.reason || "", /local operator/);
    assert.equal((await control.detail("planning", first.id)).revisions.length, 4);
  } finally { await env.cleanup(); }
});

test("admin list filters compose and transitions keep the selected active memory", async () => {
  const env = await fixtureWorkspace("control-transitions");
  try {
    const control = new MemoryControlService();
    const a = await control.create("planning");
    const b = await control.create("planning", "review");
    await control.activate("planning", a.id);
    assert.equal((await control.tasks.current("planning"))?.id, a.id);
    await control.tasks.note("planning", { type: "question", text: "How does authorization work?" });
    assert.deepEqual((await control.list("planning", { query: "authorization", status: "active", phase: "investigation", unresolved: "yes", has_spec: "no" })).map((x) => x.id), [a.id]);
    assert.deepEqual((await control.list("planning", { phase: "review" })).map((x) => x.id), [b.id]);
    assert.deepEqual((await control.list("planning", { has_spec: "yes" })).map((x) => x.id), []);
    assert.deepEqual((await control.list("planning", { unresolved: "no" })).map((x) => x.id), [b.id]);
    assert.equal((await control.list("planning", { modified: "day" })).length, 2);
    await control.tasks.setSpec("planning", { summary: "Authorization", requirements: [{ statement: "Check access", kind: "constraint", priority: "must" }] });
    assert.deepEqual((await control.list("planning", { has_spec: "yes", query: "Check access" })).map((x) => x.id), [a.id]);
    await control.activate("planning", b.id);
    assert.equal((await control.tasks.current("planning"))?.id, b.id);
    assert.equal((await control.tasks.read("planning", a.id)).status, "paused");
    await control.pause("planning", b.id);
    assert.equal(await control.tasks.current("planning"), undefined);
    await control.complete("planning", a.id);
    assert.equal((await control.tasks.read("planning", a.id)).status, "completed");
    assert.ok((await control.list("planning", { status: "completed", sort: "title" })).some((x) => x.id === a.id));
    await assert.rejects(control.activate("planning", a.id), /Completed memory/);
    assert.equal((await controlRoute("GET", "/api/active", new URLSearchParams({ workspace: "planning" }), undefined, control) as { memory_id?: string }).memory_id, undefined);
  } finally { await env.cleanup(); }
});

test("control routes provide create, filtered list, detail, phase, lifecycle and rollback", async () => {
  const env = await fixtureWorkspace("control-routes");
  try {
    const control = new MemoryControlService();
    const q = (extra: Record<string, string> = {}) => new URLSearchParams({ workspace: "planning", ...extra });
    const created = await controlRoute("POST", "/api/memories", q(), { workspace: "planning", phase: "investigation" }, control) as { id: string; status: string };
    assert.equal(created.status, "paused");
    assert.deepEqual((await controlRoute("GET", "/api/memories", q({ query: "planning", status: "paused" }), undefined, control) as Array<{ id: string }>).map((x) => x.id), [created.id]);
    await controlRoute("POST", `/api/memories/${created.id}/activate`, q(), { workspace: "planning" }, control);
    assert.equal((await controlRoute("GET", "/api/active", q(), undefined, control) as { memory_id: string }).memory_id, created.id);
    await controlRoute("POST", `/api/memories/${created.id}/phase`, q(), { workspace: "planning", phase: "review" }, control);
    await control.tasks.setSpec("planning", { summary: "Route spec", requirements: [{ statement: "A", kind: "constraint", priority: "must" }] });
    const detail = await controlRoute("GET", `/api/memories/${created.id}`, q(), undefined, control) as { revisions: unknown[]; memory: { phase: string } };
    assert.equal(detail.memory.phase, "review"); assert.equal(detail.revisions.length, 1);
    const rollback = await controlRoute("POST", `/api/memories/${created.id}/rollback`, q(), { workspace: "planning", revision: 1 }, control) as { revision: number };
    assert.equal(rollback.revision, 2);
    await controlRoute("POST", `/api/memories/${created.id}/pause`, q(), { workspace: "planning" }, control);
    assert.equal((await control.tasks.read("planning", created.id)).status, "paused");
    await controlRoute("POST", `/api/memories/${created.id}/complete`, q(), { workspace: "planning" }, control);
    assert.equal((await control.tasks.read("planning", created.id)).status, "completed");
  } finally { await env.cleanup(); }
});

test("active plan needs a confirmed suspension before switching memories", async () => {
  const env = await fixtureWorkspace("control-plan-conflict");
  try {
    const control = new MemoryControlService();
    const a = await control.create("planning"); const b = await control.create("planning");
    await control.activate("planning", a.id);
    await control.tasks.setSpec("planning", { summary: "Investigate", requirements: [{ statement: "Find evidence", kind: "constraint", priority: "must" }] });
    const plans = new PlanService();
    await plans.create("planning", [{ kind: "investigation", title: "Inspect", objective: "Find evidence", covers: ["R1"],
      acceptance: [{ statement: "Evidence found", covers: ["R1"] }], verification: [{ kind: "custom", program: "node", args: ["--version"] }] }]);
    await assert.rejects(control.activate("planning", b.id), /ACTIVE_PLAN_CONFIRMATION_REQUIRED/);
    assert.equal((await control.tasks.current("planning"))?.id, a.id);
    await control.activate("planning", b.id, "suspend");
    assert.equal((await control.planStorage.read("planning", a.id))?.status, "suspended");
    assert.equal((await control.tasks.current("planning"))?.id, b.id);
  } finally { await env.cleanup(); }
});

test("control transitions restore memory and plan after partial writes", async () => {
  const env = await fixtureWorkspace("control-transition-failure");
  try {
    const control = new MemoryControlService();
    const a = await control.create("planning"); const b = await control.create("planning");
    await control.activate("planning", a.id);
    await control.tasks.setSpec("planning", { summary: "Investigate", requirements: [{ statement: "Find evidence", kind: "constraint", priority: "must" }] });
    const plans = new PlanService();
    await plans.create("planning", [{ kind: "investigation", title: "Inspect", objective: "Find evidence", covers: ["R1"],
      acceptance: [{ statement: "Evidence found", covers: ["R1"] }], verification: [{ kind: "custom", program: "node", args: ["--version"] }] }]);
    const initialMemory = await control.tasks.read("planning", a.id);
    const initialPlan = await control.planStorage.read("planning", a.id);
    assert.ok(initialPlan);

    const failPlanOnce = async (operation: () => Promise<unknown>) => {
      const write = control.planStorage.write.bind(control.planStorage);
      let fail = true;
      control.planStorage.write = async (workspace, plan) => {
        await write(workspace, plan);
        if (fail) { fail = false; throw new Error("injected plan write failure"); }
      };
      try { await assert.rejects(operation(), /injected plan write failure/); }
      finally { control.planStorage.write = write; }
    };
    const failMemoryOnce = async (id: string, status: string, operation: () => Promise<unknown>) => {
      const write = control.tasks.storage.write.bind(control.tasks.storage);
      let fail = true;
      control.tasks.storage.write = async (workspace, state) => {
        await write(workspace, state);
        if (fail && state.id === id && state.status === status) { fail = false; throw new Error("injected memory write failure"); }
      };
      try { await assert.rejects(operation(), /injected memory write failure/); }
      finally { control.tasks.storage.write = write; }
    };
    const assertRestored = async () => {
      assert.deepEqual(await control.tasks.read("planning", a.id), initialMemory);
      assert.deepEqual(await control.planStorage.read("planning", a.id), initialPlan);
      assert.equal((await control.tasks.read("planning", b.id)).status, "paused");
      assert.equal((await control.tasks.current("planning"))?.id, a.id);
    };

    await failPlanOnce(() => control.activate("planning", b.id, "suspend"));
    await assertRestored();
    await failMemoryOnce(a.id, "paused", () => control.activate("planning", b.id, "suspend"));
    await assertRestored();
    await failMemoryOnce(b.id, "active", () => control.activate("planning", b.id, "suspend"));
    await assertRestored();
    await failPlanOnce(() => control.pause("planning", a.id, "suspend"));
    await assertRestored();
    await failMemoryOnce(a.id, "paused", () => control.pause("planning", a.id, "suspend"));
    await assertRestored();
    await failPlanOnce(() => control.complete("planning", a.id, "abandon"));
    await assertRestored();
    await failMemoryOnce(a.id, "completed", () => control.complete("planning", a.id, "abandon"));
    await assertRestored();
  } finally { await env.cleanup(); }
});

test("control page has search, filters, tabs, confirmations, and no mutation text fields", () => {
  const page = controlPage("test-token");
  assert.match(page, /type="search"/);
  for (const id of ["workspace", "status", "phase", "has_spec", "unresolved", "modified", "sort", "dialog", "revision"]) assert.ok(page.includes(id));
  for (const tab of ["overview", "specification", "notes", "history"]) assert.ok(page.includes(tab));
  assert.doesNotMatch(page, /<textarea|type="text"/);
  const script = page.match(/<script[^>]*>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new vm.Script(script));
});
