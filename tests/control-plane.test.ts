import test from "node:test";
import assert from "node:assert/strict";
import { fixtureWorkspace } from "./helpers.js";
import { TaskService } from "../src/task-state/service.js";
import { MemoryControlService } from "../src/control/service.js";
import { controlRoute, isControlPagePath } from "../src/control/server.js";
import { controlPage } from "../src/control/page.js";
import { memoryInput, parseMemoryAction } from "../src/mcp/schemas.js";
import { PlanService } from "../src/plan/service.js";
import { PlanGuard } from "../src/plan/guard.js";
import { deriveStage } from "../src/orchestration/stage.js";
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

test("memory titles can be supplied, defaulted, and changed through control routes", async () => {
  const env = await fixtureWorkspace("control-titles");
  try {
    const control = new MemoryControlService();
    const q = new URLSearchParams({ workspace: "planning" });
    const custom = await controlRoute("POST", "/api/memories", q,
      { workspace: "planning", title: "  Investigate login failures  " }, control) as { id: string; title: string };
    assert.equal(custom.title, "Investigate login failures");
    assert.equal((await control.tasks.read("planning", custom.id)).title, custom.title);
    const automatic = await controlRoute("POST", "/api/memories", q,
      { workspace: "planning", title: "   " }, control) as { title: string };
    assert.match(automatic.title, /^planning - .* UTC$/);
    const renamed = await controlRoute("POST", `/api/memories/${custom.id}/title`, q,
      { workspace: "planning", title: "  Login investigation  " }, control) as { title: string };
    assert.equal(renamed.title, "Login investigation");
    assert.equal((await control.list("planning", { query: "Login investigation" }))[0]?.id, custom.id);
    await assert.rejects(controlRoute("POST", `/api/memories/${custom.id}/title`, q,
      { workspace: "planning", title: "   " }, control), /too_small|at least 1/i);
    await assert.rejects(controlRoute("POST", "/api/memories", q,
      { workspace: "planning", title: "x".repeat(121) }, control), /too_big|at most 120/i);
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
    await assert.rejects(control.complete("planning", a.id, "abandon"), /PLAN_REVIEW_REQUIRED/);
    await assertRestored();
  } finally { await env.cleanup(); }
});

test("control page has search, filters, tabs, confirmations, and title fields", () => {
  const page = controlPage("test-token");
  assert.match(page, /Requirement traceability/);
  assert.match(page, /Structural coverage only/);
  assert.match(page, /type="search"/);
  for (const id of ["workspace", "status", "phase", "has_spec", "spec_archived", "unresolved", "modified", "sort", "dialog", "revision"]) assert.ok(page.includes(id));
  for (const tab of ["overview", "specification", "notes", "history"]) assert.ok(page.includes(tab));
  assert.match(page, /id="newTitle"/);
  assert.match(page, /id="renameTitle"/);
  assert.match(page, /appearance:none/);
  for (const action of ["archiveMemory", "deleteMemory", "noteArchive", "noteMarkdown", "specArchive", "spec:delete", "plan:delete", "deleteConfirm"]) assert.ok(page.includes(action));
  assert.doesNotMatch(page, /<textarea/);
  const script = page.match(/<script[^>]*>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new vm.Script(script));
  for (const action of ["rename", "archive", "delete", "pause", "complete"]) assert.match(page, new RegExp(`action-${action}`));
  assert.match(page, /spec archived/);
  assert.match(page, /href="'\+esc\(pagePath/);
  assert.match(page, /memoryListLink/);
  assert.match(page, /importMemory/);
  assert.match(page, /Plan and its specification/);
  assert.match(page, /data-reuse-spec/);
  assert.match(page, /data-reuse-plan/);
});

test("the plan tab shows Archive plan and confirms a selected status change", () => {
  const script = controlPage("test-token").match(/<script[^>]*>([\s\S]*?)<\/script>/)?.[1]!;
  const helpers = script.slice(0, script.indexOf("function renderSpec"));
  type Stub = { value: string; innerHTML: string; onclick?: () => void; onchange?: () => void; disabled?: boolean; textContent?: string; showModal?: () => void };
  const elements = new Map<string, Stub>([["planStatus", { value: "active", innerHTML: "" }]]);
  const document = { getElementById(id: string) {
    if (!elements.has(id)) elements.set(id, { value: "no", innerHTML: "", showModal() {} });
    return elements.get(id)!;
  }, querySelectorAll() { return []; } };
  const html = vm.runInNewContext(`${helpers}\nworkspace='planning';selected='task-1';tab='plan';detail={memory:{id:'task-1',title:'Task',status:'active',updated_at:'2026-01-01',records:[]},plan:{plan:{status:'active',spec_revision:1,steps:[{id:'S1',title:'Step',objective:'Work',status:'current',kind:'investigation',covers:[],writes:[],modified_paths:[]}]},stale:false,review_gate:'pending',traceability:[],unresolved_markers:[]}};render();$('detail').innerHTML`, {
    document, window: { addEventListener() {} }, location: { pathname: "/", search: "" },
    history: { pushState() {}, replaceState() {} }, URLSearchParams,
  }) as string;
  assert.match(html, /data-manage="plan:archive">Archive plan/);
  for (const status of ["active", "suspended", "final_review", "completed", "abandoned"]) assert.match(html, new RegExp(`value="${status}"`));
  assert.equal(elements.get("changePlanStatus")?.disabled, true);
  elements.get("planStatus")!.value = "suspended";
  elements.get("planStatus")!.onchange?.();
  assert.equal(elements.get("changePlanStatus")?.disabled, false);
  elements.get("changePlanStatus")!.onclick?.();
  assert.match(elements.get("dialogText")?.textContent || "", /Change from active to suspended/);
  assert.match(elements.get("dialogText")?.textContent || "", /does not run checks/);
});

test("multiple archived specifications remain available while a new spec is created", async () => {
  const env = await fixtureWorkspace("control-multiple-specs");
  try {
    const control = new MemoryControlService();
    const memory = await control.create("planning", "investigation", "Spec archive");
    await control.activate("planning", memory.id);
    const guard = new PlanGuard(control.plans);
    for (const summary of ["First", "Second"]) {
      await control.tasks.setSpec("planning", { summary, requirements: [{ statement: summary, kind: "constraint", priority: "must" }] });
      assert.equal((await guard.beforeShell("planning", "node --version")).allowed, false);
      await control.archiveSpec("planning", memory.id, true);
      assert.equal((await deriveStage(control.plans, "planning")).stage, "investigation");
      assert.equal((await guard.beforeShell("planning", "node --version")).allowed, true);
    }
    const third = await control.tasks.setSpec("planning", { summary: "Third", requirements: [{ statement: "Third", kind: "constraint", priority: "must" }] });
    const detail = await control.detail("planning", memory.id);
    assert.equal(third.spec.revision, 3);
    assert.equal(detail.memory.spec_archived_at, undefined);
    assert.deepEqual(detail.archived_specs.map((spec) => spec.summary), ["First", "Second"]);
    assert.equal(detail.memory.spec?.summary, "Third");
    assert.equal((await deriveStage(control.plans, "planning")).stage, "planning");
    const target = await control.create("planning", "investigation", "Imported old spec");
    await control.importFromMemory("planning", target.id, memory.id, { notes: false, spec: true, plan: false, spec_revision: 1 });
    assert.equal((await control.tasks.read("planning", target.id)).spec?.summary, "First");
    await controlRoute("POST", `/api/memories/${memory.id}/import`, new URLSearchParams({ workspace: "planning" }),
      { workspace: "planning", source_id: memory.id, notes: false, spec: true, plan: false, spec_revision: 1 }, control);
    const reused = await control.detail("planning", memory.id);
    assert.equal(reused.memory.spec?.revision, 4);
    assert.equal(reused.memory.spec?.summary, "First");
    assert.deepEqual(reused.archived_specs.map((spec) => spec.summary), ["First", "Second", "Third"]);
  } finally { await env.cleanup(); }
});

test("multiple archived plans remain in history when another plan is created", async () => {
  const env = await fixtureWorkspace("control-multiple-plans");
  try {
    const control = new MemoryControlService();
    const memory = await control.create("planning", "investigation", "Plan archive");
    await control.activate("planning", memory.id);
    await control.tasks.setSpec("planning", { summary: "Inspect", requirements: [{ statement: "Inspect", kind: "constraint", priority: "must" }] });
    for (const title of ["First", "Second"]) {
      await control.plans.create("planning", [{ kind: "investigation", title, objective: title, covers: ["R1"],
        acceptance: [{ statement: "Done", covers: ["R1"] }], verification: [{ kind: "custom", program: "node", args: ["--version"] }] }]);
      await control.planTransition("planning", memory.id, "suspend");
      await control.archivePlan("planning", memory.id, true);
      assert.equal((await deriveStage(control.plans, "planning")).stage, "planning");
    }
    await control.plans.create("planning", [{ kind: "investigation", title: "Third", objective: "Third", covers: ["R1"],
      acceptance: [{ statement: "Done", covers: ["R1"] }], verification: [{ kind: "custom", program: "node", args: ["--version"] }] }]);
    const detail = await control.detail("planning", memory.id);
    assert.deepEqual(detail.archived_plans.map((plan) => plan.steps[0]?.title).sort(), ["First", "Second"]);
    assert.equal(detail.plan.plan?.steps[0]?.title, "Third");
    const first = detail.archived_plan_entries.find((entry) => entry.plan.steps[0]?.title === "First");
    assert.ok(first);
    const target = await control.create("planning", "investigation", "Imported old plan");
    await control.importFromMemory("planning", target.id, memory.id,
      { notes: false, spec: false, plan: true, plan_archive_id: first.id });
    assert.equal((await control.planStorage.read("planning", target.id))?.steps[0]?.title, "First");
    assert.equal((await control.tasks.read("planning", target.id)).spec?.summary, "Inspect");
    await assert.rejects(control.importFromMemory("planning", memory.id, memory.id,
      { notes: false, spec: false, plan: true, plan_archive_id: first.id }), /current plan/);
    await control.planTransition("planning", memory.id, "suspend");
    await control.archivePlan("planning", memory.id, true);
    await controlRoute("POST", `/api/memories/${memory.id}/import`, new URLSearchParams({ workspace: "planning" }),
      { workspace: "planning", source_id: memory.id, notes: false, spec: false, plan: true, plan_archive_id: first.id }, control);
    const reused = await control.detail("planning", memory.id);
    assert.equal(reused.memory.spec?.revision, 2);
    assert.equal(reused.plan.plan?.steps[0]?.title, "First");
    assert.equal(reused.plan.plan?.status, "suspended");
    assert.equal(reused.plan.stale, false);
    assert.ok(reused.archived_plans.some((plan) => plan.steps[0]?.title === "Third"));
  } finally { await env.cleanup(); }
});

test("archiving a plan in final review pauses it and restoring resumes final review", async () => {
  const env = await fixtureWorkspace("control-archive-final-review");
  try {
    const control = new MemoryControlService();
    const memory = await control.create("planning", "investigation", "Review archive");
    await control.activate("planning", memory.id);
    await control.tasks.setSpec("planning", { summary: "Review", requirements: [{ statement: "Inspect", kind: "constraint", priority: "must" }] });
    const plan = await control.plans.create("planning", [{ kind: "investigation", title: "Inspect", objective: "Inspect", covers: ["R1"],
      acceptance: [{ statement: "Done", covers: ["R1"] }], verification: [{ kind: "custom", program: "node", args: ["--version"] }] }]);
    plan.status = "final_review";
    plan.steps[0]!.status = "completed";
    await control.planStorage.write("planning", plan);
    const archived = await control.archivePlan("planning", memory.id, true);
    assert.equal(archived.status, "suspended");
    assert.equal(archived.archived_previous_status, "final_review");
    assert.equal((await deriveStage(control.plans, "planning")).stage, "planning");
    const restored = await control.archivePlan("planning", memory.id, false);
    assert.equal(restored.status, "final_review");
    assert.equal(restored.archived_previous_status, undefined);
    assert.equal((await deriveStage(control.plans, "planning")).stage, "final_review");
  } finally { await env.cleanup(); }
});

test("UI plan status route accepts every manual transition without fabricating review evidence", async () => {
  const env = await fixtureWorkspace("control-plan-status");
  try {
    const control = new MemoryControlService();
    const memory = await control.create("planning", "investigation", "Status choices");
    await control.activate("planning", memory.id);
    await control.tasks.setSpec("planning", { summary: "Inspect", requirements: [{ statement: "Inspect", kind: "constraint", priority: "must" }] });
    await control.plans.create("planning", [{ kind: "investigation", title: "Inspect", objective: "Inspect", covers: ["R1"],
      acceptance: [{ statement: "Done", covers: ["R1"] }], verification: [{ kind: "custom", program: "node", args: ["--version"] }] }]);
    const plan = (await control.planStorage.read("planning", memory.id))!;
    plan.final_evidence = { covered_requirements: ["R1"], modified_paths: [], verifications: [], completed_at: new Date().toISOString() };
    plan.review_receipt = { skill: "code-review-and-quality", code_hash: "0".repeat(64), reviewed_at: new Date().toISOString(), status: "completed", blocking_findings: false };
    await control.planStorage.write("planning", plan);
    const route = (status: string, reason = "Operator confirmed") => controlRoute("POST", `/api/memories/${memory.id}/plan/status`,
      new URLSearchParams({ workspace: "planning" }), { workspace: "planning", status, reason }, control);
    for (const status of ["final_review", "completed", "active", "abandoned", "suspended", "completed"] as const) {
      const updated = await route(status, "") as { status: string; review_receipt?: unknown; final_evidence?: unknown };
      assert.equal(updated.status, status);
      assert.equal(updated.review_receipt, undefined);
      assert.equal(updated.final_evidence, undefined);
    }
    assert.equal((await control.plans.inspect("planning", memory.id)).receipt_current, false);
    await assert.rejects(control.complete("planning", memory.id), /PLAN_REVIEW_REQUIRED/);
    await control.archivePlan("planning", memory.id, true);
    const restored = await route("active") as { status: string; archived_at?: string; steps: Array<{ status: string }> };
    assert.equal(restored.status, "active");
    assert.equal(restored.archived_at, undefined);
    assert.equal(restored.steps[0]?.status, "current");
    assert.equal((await control.plans.inspect("planning", memory.id)).review_gate, "not_ready");
    await assert.rejects(route("invalid"), /active|suspended|final_review|completed|abandoned/);
  } finally { await env.cleanup(); }
});

test("import copies notes with fresh IDs and a plan with its bound spec", async () => {
  const env = await fixtureWorkspace("control-import-memory");
  try {
    const control = new MemoryControlService();
    const source = await control.create("planning", "investigation", "Source");
    const target = await control.create("planning", "investigation", "Target");
    await control.activate("planning", source.id);
    await control.tasks.note("planning", { type: "observation", text: "Useful finding" });
    await control.tasks.note("planning", { type: "observation", text: "Useful finding" });
    await control.tasks.setSpec("planning", { summary: "Original", requirements: [{ statement: "Inspect", kind: "constraint", priority: "must" }] });
    await control.plans.create("planning", [{ kind: "investigation", title: "Inspect source", objective: "Inspect", covers: ["R1"],
      acceptance: [{ statement: "Done", covers: ["R1"] }], verification: [{ kind: "custom", program: "node", args: ["--version"] }] }]);
    await control.tasks.setSpec("planning", { summary: "Changed later", requirements: [{ id: "R1", statement: "Different", kind: "constraint", priority: "must" }] });
    const q = new URLSearchParams({ workspace: "planning" });
    const result = await controlRoute("POST", `/api/memories/${target.id}/import`, q,
      { workspace: "planning", source_id: source.id, notes: true, spec: false, plan: true }, control) as { imported_notes: number; plan_status: string };
    assert.equal(result.imported_notes, 2);
    assert.equal(result.plan_status, "suspended");
    const detail = await control.detail("planning", target.id);
    assert.equal(detail.memory.spec?.summary, "Original");
    assert.equal(detail.plan.stale, false);
    assert.equal(detail.memory.records[0]?.id, "M1");
    assert.equal(detail.memory.records[0]?.text, "Useful finding");
    assert.deepEqual(detail.memory.records[0]?.evidence_refs, []);
    assert.equal(detail.memory.records[1]?.id, "M2");
    await control.deleteNote("planning", target.id, "M2");
    const findings = await import("node:fs/promises").then(({ readFile }) => readFile(control.tasks.storage.findingsPath("planning", target.id), "utf8"));
    assert.match(findings, new RegExp(detail.memory.records[0]!.created_at));
    assert.doesNotMatch(findings, new RegExp(detail.memory.records[1]!.created_at));
    await control.activate("planning", target.id, "suspend");
    await control.planTransition("planning", target.id, "reactivate");
    assert.equal((await control.planStorage.read("planning", target.id))?.status, "active");
    assert.ok((await control.planStorage.read("planning", target.id))?.repository_baseline);
    await assert.rejects(control.importFromMemory("planning", source.id, source.id, { notes: true, spec: false, plan: false }), /saved specification revision or plan/);
  } finally { await env.cleanup(); }
});

test("operator traceability renders changed paths, executed results, missing links and blocked review", () => {
  const renderer = controlPage("test-token").match(/^function renderTraceability\(info\).*$/m)?.[0];
  assert.ok(renderer);
  const render = vm.runInNewContext(`const esc=s=>String(s);${renderer};renderTraceability`, {}) as (value: unknown) => string;
  const html = render({ traceability: [{ requirement_id: "R1", statement: "Feature works", review_status: "blocked or stale",
    steps: [{ step_id: "S1", title: "Implement feature", kind: "implementation", status: "completed",
      modified_paths: ["repo:src/feature.ts"], verifications: [{ command: "npm test", result: "pass", last_exit: 0, expected_exit: 0 }], gaps: [] },
    { step_id: "S2", title: "Check feature", kind: "verification", status: "current", modified_paths: [], verifications: [],
      gaps: ["No verification linked to this requirement"] }],
    gaps: ["Review receipt is blocked or stale"],
    review_findings: [{ severity: "Required", disposition: "open", summary: "Missing case" }] }] });
  for (const text of ["R1", "S1 · Implement feature", "repo:src/feature.ts", "Verification: npm test · pass (exit 0, expected 0)",
    "No verification linked to this requirement", "Review receipt is blocked or stale", "Required · open: Missing case"]) assert.ok(html.includes(text));
});

test("control UI routes provide deep links for workspaces, memories, tabs, archived notes, and archived specs", () => {
  for (const path of ["/", "/workspaces/planning/memories", "/workspaces/planning/memories/task-1/overview",
    "/workspaces/planning/memories/task-1/specification", "/workspaces/planning/memories/task-1/notes",
    "/workspaces/planning/memories/task-1/plan", "/workspaces/planning/memories/task-1/history"]) assert.equal(isControlPagePath(path), true);
  for (const path of ["/api/memories", "/workspaces/planning/memories/task-1/delete", "/workspaces/planning/memories/task-1/notes/M1",
    "/workspaces/../memories", "/workspaces/planning/other"]) assert.equal(isControlPagePath(path), false);
  const script = controlPage("test-token").match(/<script[^>]*>([\s\S]*?)<\/script>/)?.[1]!;
  const helpers = script.split("function showError")[0]!;
  const result = vm.runInNewContext(`${helpers}\n({path:pagePath('planning','task-1','notes','yes','all','yes'),route:routeSnapshot()})`, {
    location: { pathname: "/workspaces/planning/memories/task-1/notes", search: "?archived=yes&notes=yes" },
    window: { addEventListener() {} }, document: { getElementById() { return { value: "no" }; } },
    history: { pushState() {}, replaceState() {} }, URLSearchParams,
  }) as { path: string; route: { workspace: string; memory: string; section: string; archived: string; notes: string } };
  assert.equal(result.path, "/workspaces/planning/memories/task-1/notes?archived=yes&notes=yes");
  assert.equal(result.route.workspace, "planning");
  assert.equal(result.route.memory, "task-1");
  assert.equal(result.route.section, "notes");
  assert.equal(result.route.archived, "yes");
  assert.equal(result.route.notes, "yes");
  const specRoute = vm.runInNewContext(`${helpers}\n({path:pagePath('planning','task-1','specification','no','all','no','yes'),route:routeSnapshot()})`, {
    location: { pathname: "/workspaces/planning/memories/task-1/specification", search: "?specs=yes" },
    window: { addEventListener() {} }, document: { getElementById() { return { value: "no" }; } },
    history: { pushState() {}, replaceState() {} }, URLSearchParams,
  }) as { path: string; route: { specs: string } };
  assert.equal(specRoute.path, "/workspaces/planning/memories/task-1/specification?specs=yes");
  assert.equal(specRoute.route.specs, "yes");
});

test("specification filter hides archived specs by default and shows them when selected", () => {
  const script = controlPage("test-token").match(/<script[^>]*>([\s\S]*?)<\/script>/)?.[1]!;
  const helpers = script.slice(0, script.indexOf("function renderNotes"));
  const content = { innerHTML: "", querySelectorAll: () => [] };
  const archive = { value: "no" };
  const context = {
    location: { pathname: "/", search: "" }, URLSearchParams, window: { addEventListener() {} },
    document: { getElementById(id: string) { return id === "specArchive" ? archive : content; } },
    history: { pushState() {}, replaceState() {} },
  };
  const result = vm.runInNewContext(`${helpers}\ndetail={memory:{spec_archived_at:'2026-01-01',spec:{revision:1,summary:'Archived summary',requirements:[]}},legacy_spec:null,plan:null};renderSpec();const hidden=$('specContent').innerHTML;$('specArchive').value='yes';renderSpec();const archived=$('specContent').innerHTML;$('specArchive').value='all';renderSpec();const all=$('specContent').innerHTML;detail.memory.spec_archived_at=undefined;$('specArchive').value='no';renderSpec();({hidden,archived,all,visible:$('specContent').innerHTML})`, context) as { hidden: string; archived: string; all: string; visible: string };
  assert.doesNotMatch(result.hidden, /Archived summary|Restore spec/);
  assert.match(result.archived, /Archived summary/);
  assert.match(result.archived, /Restore spec/);
  assert.match(result.all, /Archived summary/);
  assert.match(result.visible, /Archived summary/);
  assert.match(result.visible, /Archive spec/);
  archive.value = "yes";
  const saved = vm.runInNewContext("detail={memory:{id:'task-1',status:'paused',spec:{revision:3,summary:'Current',requirements:[]}},legacy_spec:null,plan:null,archived_specs:[{revision:1,summary:'Older',requirements:[],archived_at:'2026-01-01'}]};renderSpec();$('specContent').innerHTML", context) as string;
  assert.match(saved, /Older/);
  assert.match(saved, /data-reuse-spec="1"/);
});

test("notes Markdown checkbox switches from source text to escaped formatted content", () => {
  const script = controlPage("test-token").match(/<script[^>]*>([\s\S]*?)<\/script>/)?.[1]!;
  const helpers = script.slice(0, script.indexOf("function renderRevision"));
  const elements: Record<string, { value: string; innerHTML: string; onclick?: () => void; onkeydown?: () => void }> = {
    noteKind: { value: "all", innerHTML: "" }, noteStatus: { value: "all", innerHTML: "" },
    noteArchive: { value: "no", innerHTML: "" }, notesList: { value: "", innerHTML: "" },
    cancel: { value: "", innerHTML: "" }, dialog: { value: "", innerHTML: "" },
  };
  const context = {
    location: { pathname: "/", search: "" }, URLSearchParams, window: { addEventListener() {} },
    document: { getElementById(id: string) { return elements[id]; }, querySelectorAll() { return []; } },
    history: { pushState() {}, replaceState() {} },
  };
  const result = vm.runInNewContext(`${helpers}\ndetail={memory:{records:[{id:'M1',kind:'question',status:'open',text:'## Heading\\n\\n**bold** and <img src=x onerror=alert(1)>',confidence:'high',evidence_refs:[],updated_at:'2026-01-01'}]}};renderNotes();const source=$('notesList').innerHTML;noteMarkdownView=true;renderNotes();({source,formatted:$('notesList').innerHTML})`, context) as { source: string; formatted: string };
  assert.match(result.source, /## Heading/);
  assert.doesNotMatch(result.source, /<h2>/);
  assert.match(result.formatted, /<h2>Heading<\/h2>/);
  assert.match(result.formatted, /<strong>bold<\/strong>/);
  assert.doesNotMatch(result.formatted, /<img/);
  assert.match(result.formatted, /&lt;img/);
});

test("control UI restores deep links to archived content and canonicalizes archive filters", async () => {
  const script = controlPage("test-token").match(/<script[^>]*>([\s\S]*?)<\/script>/)?.[1]!;
  const helpers = script.split("function showError")[0]!;
  const open = async (pathname: string, search: string, archived: boolean) => {
    const location = { pathname, search };
    const elements: Record<string, { value: string }> = {
      workspace: { value: "" }, archived: { value: "no" }, spec_archived: { value: "all" },
    };
    const context = {
      location, URLSearchParams, window: { addEventListener() {} },
      document: { getElementById(id: string) { return elements[id]; } },
      history: { replaceState(_state: unknown, _title: string, url: string) {
        const parsed = new URL(url, "http://localhost"); location.pathname = parsed.pathname; location.search = parsed.search;
      }, pushState() {} },
      fetch: async () => ({ ok: true, json: async () => ({ memory: { archived_at: archived ? "2026-01-01" : undefined } }) }),
    };
    const result = await vm.runInNewContext(`${helpers}\nworkspaces=[{id:'planning'}];async function refresh(){};applyRoute().then(()=>({workspace,selected,tab,archive:$('archived').value,specArchive:$('spec_archived').value,notes:noteArchiveView,specs:specArchiveView}))`, context) as Record<string, string>;
    return { ...result, pathname: location.pathname, search: location.search } as Record<string, string>;
  };
  const specList = await open("/workspaces/planning/memories", "?spec_archived=yes", false);
  assert.equal(specList.archive, "all");
  assert.equal(specList.search, "?archived=all&spec_archived=yes");
  const notes = await open("/workspaces/planning/memories/task-1/notes", "?notes=yes", true);
  assert.equal(notes.selected, "task-1"); assert.equal(notes.tab, "notes");
  assert.equal(notes.archive, "yes"); assert.equal(notes.notes, "yes");
  assert.equal(notes.search, "?archived=yes&notes=yes");
  const specs = await open("/workspaces/planning/memories/task-1/specification", "?specs=yes", false);
  assert.equal(specs.specs, "yes");
  assert.equal(specs.search, "?specs=yes");
});

test("control archive and delete manage memory, notes, spec and plan without changing MCP actions", async () => {
  const env = await fixtureWorkspace("control-cleanup");
  try {
    const control = new MemoryControlService();
    const q = new URLSearchParams({ workspace: "planning" });
    const memory = await control.create("planning", "investigation", "Cleanup test");
    await control.activate("planning", memory.id);
    await control.tasks.note("planning", { type: "question", text: "First question" });
    await control.tasks.note("planning", { type: "question", text: "Second question" });
    await controlRoute("POST", `/api/memories/${memory.id}/notes/M1/archive`, q, { workspace: "planning" }, control);
    assert.ok((await control.detail("planning", memory.id)).memory.records.find((item) => item.id === "M1")?.archived_at);
    await controlRoute("POST", `/api/memories/${memory.id}/notes/M1/restore`, q, { workspace: "planning" }, control);
    assert.equal((await control.detail("planning", memory.id)).memory.records.find((item) => item.id === "M1")?.archived_at, undefined);
    await controlRoute("POST", `/api/memories/${memory.id}/notes/M2/delete`, q, { workspace: "planning" }, control);
    const findings = await import("node:fs/promises").then(({ readFile }) => readFile(control.tasks.storage.findingsPath("planning", memory.id), "utf8"));
    assert.doesNotMatch(findings, /Second question/);
    assert.match(findings, /First question/);
    const added = await control.tasks.note("planning", { type: "question", text: "Third question" });
    assert.equal(added.records[0]?.id, "M3");

    await control.tasks.setSpec("planning", { summary: "Cleanup spec", requirements: [{ statement: "Inspect", kind: "constraint", priority: "must" }] });
    const plans = new PlanService();
    await plans.create("planning", [{ kind: "investigation", title: "Inspect", objective: "Inspect state", covers: ["R1"],
      acceptance: [{ statement: "State inspected", covers: ["R1"] }], verification: [{ kind: "custom", program: "node", args: ["--version"] }] }]);
    await assert.rejects(control.archiveMemory("planning", memory.id, true), /Suspend or abandon/);
    await assert.rejects(control.deleteSpec("planning", memory.id), /Delete the associated plan/);
    await controlRoute("POST", `/api/memories/${memory.id}/plan/archive`, q, { workspace: "planning" }, control);
    assert.equal((await control.planStorage.read("planning", memory.id))?.status, "suspended");
    assert.ok((await control.planDetail("planning", memory.id)).plan?.archived_at);
    await assert.rejects(control.planTransition("planning", memory.id, "reactivate"), /Restore this archived plan/);
    await controlRoute("POST", `/api/memories/${memory.id}/plan/restore`, q, { workspace: "planning" }, control);
    await control.planTransition("planning", memory.id, "reactivate");
    await control.planTransition("planning", memory.id, "suspend");
    await controlRoute("POST", `/api/memories/${memory.id}/plan/archive`, q, { workspace: "planning" }, control);
    assert.ok((await control.planDetail("planning", memory.id)).plan?.archived_at);
    await assert.rejects(control.planTransition("planning", memory.id, "reactivate"), /Restore this archived plan/);
    await controlRoute("POST", `/api/memories/${memory.id}/plan/restore`, q, { workspace: "planning" }, control);
    await control.planTransition("planning", memory.id, "abandon", "Cleanup requested by operator");
    await control.planStorage.archiveTerminal("planning", (await control.planStorage.read("planning", memory.id))!);
    await controlRoute("POST", `/api/memories/${memory.id}/plan/delete`, q, { workspace: "planning" }, control);
    assert.equal((await control.planDetail("planning", memory.id)).plan, null);
    const history = await import("node:fs/promises").then(({ readdir }) => readdir(`${control.tasks.storage.taskPath("planning", memory.id)}/plan-history`).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    }));
    assert.equal(history.length, 0);

    await controlRoute("POST", `/api/memories/${memory.id}/spec/archive`, q, { workspace: "planning" }, control);
    assert.ok((await control.detail("planning", memory.id)).memory.spec_archived_at);
    assert.deepEqual((await control.list("planning", { spec_archived: "yes" })).map((item) => item.id), [memory.id]);
    assert.equal((await control.detail("planning", memory.id)).memory.spec?.summary, "Cleanup spec");
    await controlRoute("POST", `/api/memories/${memory.id}/spec/restore`, q, { workspace: "planning" }, control);
    assert.deepEqual((await control.list("planning", { spec_archived: "yes" })).map((item) => item.id), []);
    await controlRoute("POST", `/api/memories/${memory.id}/spec/delete`, q, { workspace: "planning" }, control);
    assert.equal((await control.tasks.read("planning", memory.id)).spec, undefined);
    assert.equal((await control.detail("planning", memory.id)).revisions.length, 0);
    const revisions = await import("node:fs/promises").then(({ readdir }) => readdir(`${control.tasks.storage.taskPath("planning", memory.id)}/spec-revisions`).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    }));
    assert.equal(revisions.length, 0);

    await controlRoute("POST", `/api/memories/${memory.id}/archive`, q, { workspace: "planning" }, control);
    assert.equal((await control.tasks.current("planning")), undefined);
    assert.ok((await new MemoryControlService().tasks.read("planning", memory.id)).archived_at);
    assert.deepEqual((await control.list("planning")).map((item) => item.id), []);
    assert.deepEqual((await control.list("planning", { archived: "yes" })).map((item) => item.id), [memory.id]);
    await assert.rejects(control.activate("planning", memory.id), /Restore this archived memory/);
    await controlRoute("POST", `/api/memories/${memory.id}/restore`, q, { workspace: "planning" }, control);
    assert.equal((await control.list("planning"))[0]?.id, memory.id);
    await controlRoute("POST", `/api/memories/${memory.id}/delete`, q, { workspace: "planning" }, control);
    await assert.rejects(control.tasks.read("planning", memory.id), /Unknown memory/);
    const { readFile } = await import("node:fs/promises");
    for (const file of [control.tasks.storage.statePath("planning", memory.id), control.tasks.storage.findingsPath("planning", memory.id),
      control.tasks.storage.specPath("planning", memory.id), control.tasks.storage.planPath("planning", memory.id)]) {
      await assert.rejects(readFile(file), { code: "ENOENT" });
    }
    assert.equal((await control.list("planning")).length, 0);
  } finally { await env.cleanup(); }
});

test("legacy markdown specifications can be archived and deleted", async () => {
  const env = await fixtureWorkspace("control-legacy-cleanup");
  try {
    const control = new MemoryControlService();
    const memory = await control.create("planning", "investigation", "Legacy cleanup");
    await control.tasks.storage.writeSpec("planning", memory.id, "# Specification\n\nLegacy requirement");
    assert.equal((await control.list("planning", { has_spec: "yes" }))[0]?.id, memory.id);
    assert.match((await control.detail("planning", memory.id)).legacy_spec || "", /Legacy requirement/);
    await control.archiveSpec("planning", memory.id, true);
    assert.ok((await control.detail("planning", memory.id)).memory.spec_archived_at);
    await control.deleteSpec("planning", memory.id);
    assert.equal((await control.detail("planning", memory.id)).legacy_spec, undefined);
    assert.equal((await control.list("planning", { has_spec: "no" }))[0]?.id, memory.id);
  } finally { await env.cleanup(); }
});
