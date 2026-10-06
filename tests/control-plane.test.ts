import test from "node:test";
import assert from "node:assert/strict";
import { fixtureWorkspace } from "./helpers.js";
import { TaskService } from "../src/task-state/service.js";
import { MemoryControlService } from "../src/control/service.js";
import { controlRoute, isControlPagePath } from "../src/control/server.js";
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
    await assert.rejects(control.archivePlan("planning", memory.id, true), /Suspend or abandon/);
    await assert.rejects(control.archiveMemory("planning", memory.id, true), /Suspend or abandon/);
    await assert.rejects(control.deleteSpec("planning", memory.id), /Delete the associated plan/);
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
