import { TaskService } from "../task-state/service.js";
import { PlanStorage } from "../plan/storage.js";
import { PlanService } from "../plan/service.js";
import { WorkspaceRegistry } from "../workspace/registry.js";
import type { TaskState } from "../task-state/schemas.js";
import { structuredSpecSchema } from "../task-state/schemas.js";
import { structuredSpecHash } from "../plan/binding.js";
import { planStateSchema } from "../plan/schemas.js";
import { atomicWrite } from "../shared/fs.js";

export type MemoryFilters = { query?: string; status?: string; phase?: string; has_spec?: string; spec_archived?: string; unresolved?: string; modified?: string; sort?: string; archived?: string };
export type PlanDecision = "suspend" | "abandon";
function hasLegacySpec(markdown: string): boolean {
  return markdown.split(/\r?\n/).some((line) => {
    const value = line.trim();
    return !!value && !value.startsWith("#") && value !== "Confirmed design and implementation conclusions are recorded here.";
  });
}

export class MemoryControlService {
  readonly plans: PlanService;
  constructor(readonly tasks = new TaskService(), readonly registry = new WorkspaceRegistry(), readonly planStorage = new PlanStorage(tasks.storage)) {
    this.plans = new PlanService(planStorage, tasks, registry);
  }

  async workspaces() { return this.registry.list(); }

  async list(workspace: string, filters: MemoryFilters = {}) {
    await this.registry.get(workspace);
    const query = (filters.query || "").trim().toLocaleLowerCase();
    const rows = [];
    for (const state of await this.tasks.list(workspace)) {
      if (filters.archived === "yes" ? !state.archived_at : filters.archived !== "all" && !!state.archived_at) continue;
      const spec = await this.tasks.storage.readStructuredSpec(workspace, state.id);
      const hasSpec = !!spec || hasLegacySpec(await this.tasks.storage.readSpec(workspace, state.id));
      const plan = await this.planStorage.read(workspace, state.id);
      const unresolved = state.records.some((item) => ["observed", "supported"].includes(item.status));
      const haystack = [state.title, state.objective, spec?.summary, ...(spec?.requirements.map((item) => item.statement) || []), ...state.records.map((item) => item.text)].join("\n").toLocaleLowerCase();
      if (query && !haystack.includes(query)) continue;
      if (filters.status && filters.status !== "all" && state.status !== filters.status) continue;
      if (filters.phase && filters.phase !== "all" && state.phase !== filters.phase) continue;
      if (filters.has_spec === "yes" && !hasSpec || filters.has_spec === "no" && hasSpec) continue;
      const archivedSpecs = spec ? await this.archivedSpecs(workspace, state.id, spec.revision) : [];
      if (filters.spec_archived === "yes" && !state.spec_archived_at && !archivedSpecs.length || filters.spec_archived === "no" && (!hasSpec || !!state.spec_archived_at)) continue;
      if (filters.unresolved === "yes" && !unresolved || filters.unresolved === "no" && unresolved) continue;
      if (filters.modified === "day" && Date.now() - Date.parse(state.updated_at) > 86_400_000) continue;
      if (filters.modified === "week" && Date.now() - Date.parse(state.updated_at) > 7 * 86_400_000) continue;
      if (filters.modified === "month" && Date.now() - Date.parse(state.updated_at) > 30 * 86_400_000) continue;
      rows.push({ id: state.id, title: state.title, status: state.status, phase: state.phase, archived_at: state.archived_at,
        spec_archived_at: state.spec_archived_at || archivedSpecs[0]?.archived_at, updated_at: state.updated_at,
        has_spec: hasSpec, unresolved, record_count: state.records.length, plan_status: plan?.status });
    }
    if (filters.sort === "oldest") rows.sort((a, b) => a.updated_at.localeCompare(b.updated_at));
    else if (filters.sort === "title") rows.sort((a, b) => a.title.localeCompare(b.title));
    else rows.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return rows;
  }

  async detail(workspace: string, id: string) {
    await this.registry.get(workspace);
    const memory = await this.tasks.read(workspace, id);
    const legacyMarkdown = memory.spec ? undefined : await this.tasks.storage.readSpec(workspace, id);
    const plan = await this.planStorage.read(workspace, id);
    const revisions = [];
    for (let revision = 1; revision <= (memory.spec?.revision || 0); revision++) revisions.push(await this.tasks.storage.readSpecRevision(workspace, id, revision));
    const archivedPlanEntries = await this.planStorage.historyEntries(workspace, id);
    return { memory, legacy_spec: legacyMarkdown && hasLegacySpec(legacyMarkdown) ? legacyMarkdown : undefined,
      plan_status: plan?.status, plan: await this.plans.inspect(workspace, id), revisions,
      archived_specs: revisions.filter((item) => !!item.archived_at), archived_plans: archivedPlanEntries.map((item) => item.plan),
      archived_plan_entries: archivedPlanEntries };
  }

  private async archivedSpecs(workspace: string, id: string, count: number) {
    const archived = [];
    for (let revision = 1; revision <= count; revision++) {
      const spec = await this.tasks.storage.readSpecRevision(workspace, id, revision);
      if (spec.archived_at) archived.push(spec);
    }
    return archived;
  }

  async create(workspace: string, phase = "investigation", requestedTitle?: string) {
    await this.registry.get(workspace);
    if (!["investigation", "implementation", "verification", "review"].includes(phase)) throw new Error("Invalid phase");
    const title = requestedTitle?.trim() || `${workspace} - ${new Date().toISOString().replace("T", " ").slice(0, 16)} UTC`;
    return this.tasks.create(workspace, title, { phase, activate: false });
  }

  async rename(workspace: string, id: string, title: string) {
    await this.registry.get(workspace);
    return this.tasks.update(workspace, id, { title: title.trim() });
  }

  async archiveMemory(workspace: string, id: string, archived: boolean) {
    await this.registry.get(workspace);
    return this.tasks.storage.workspaceLock(workspace, async () => {
      const memory = await this.tasks.storage.read(workspace, id);
      const plan = await this.planStorage.read(workspace, id);
      if (archived && plan && ["active", "final_review"].includes(plan.status)) throw new Error("Suspend or abandon the plan before archiving this memory");
      if (archived) memory.archived_at = new Date().toISOString(); else delete memory.archived_at;
      if (archived && memory.status === "active") memory.status = "paused";
      memory.updated_at = new Date().toISOString();
      await this.tasks.storage.write(workspace, memory);
      return memory;
    });
  }

  async deleteMemory(workspace: string, id: string) {
    await this.registry.get(workspace);
    return this.tasks.storage.workspaceLock(workspace, async () => {
      await this.tasks.storage.read(workspace, id);
      await this.tasks.storage.deleteTask(workspace, id);
      return { deleted: true, id };
    });
  }

  async archiveNote(workspace: string, id: string, recordId: string, archived: boolean) {
    await this.registry.get(workspace);
    return this.tasks.storage.workspaceLock(workspace, async () => {
      const memory = await this.tasks.storage.read(workspace, id);
      const record = memory.records.find((item) => item.id === recordId);
      if (!record) throw new Error(`Unknown note: ${recordId}`);
      if (archived) record.archived_at = new Date().toISOString(); else delete record.archived_at;
      memory.updated_at = new Date().toISOString();
      await this.tasks.storage.write(workspace, memory);
      return record;
    });
  }

  async deleteNote(workspace: string, id: string, recordId: string) {
    await this.registry.get(workspace);
    return this.tasks.storage.workspaceLock(workspace, async () => {
      const memory = await this.tasks.storage.read(workspace, id);
      const record = memory.records.find((item) => item.id === recordId);
      if (!record) throw new Error(`Unknown note: ${recordId}`);
      memory.next_record_id ||= Math.max(0, ...memory.records.map((item) => Number(item.id.slice(1)) || 0)) + 1;
      memory.records = memory.records.filter((item) => item.id !== recordId);
      memory.updated_at = new Date().toISOString();
      await this.tasks.storage.transaction(workspace, id, "delete-memory-note", async () => {
        await this.tasks.storage.removeFinding(workspace, id, record);
        await this.tasks.storage.write(workspace, memory);
      });
      return { deleted: true, record_id: recordId };
    });
  }

  async archiveSpec(workspace: string, id: string, archived: boolean) {
    await this.registry.get(workspace);
    return this.tasks.storage.workspaceLock(workspace, async () => {
      const memory = await this.tasks.storage.read(workspace, id);
      const spec = await this.tasks.storage.readStructuredSpec(workspace, id);
      if (!spec && !hasLegacySpec(await this.tasks.storage.readSpec(workspace, id))) {
        throw new Error("No specification for this memory");
      }
      if (archived && ["active", "final_review"].includes((await this.planStorage.read(workspace, id))?.status || "")) throw new Error("Suspend or abandon the plan before archiving its specification");
      if (archived) memory.spec_archived_at = new Date().toISOString(); else delete memory.spec_archived_at;
      memory.updated_at = new Date().toISOString();
      await this.tasks.storage.transaction(workspace, id, "archive-specification", async () => {
        if (spec) await this.tasks.storage.writeStructuredSpec(workspace, id, { ...spec, archived_at: memory.spec_archived_at });
        await this.tasks.storage.write(workspace, memory);
      }, spec ? [`spec_revision_${spec.revision}`] : []);
      return memory;
    });
  }

  async deleteSpec(workspace: string, id: string) {
    await this.registry.get(workspace);
    return this.tasks.storage.workspaceLock(workspace, async () => {
      const memory = await this.tasks.storage.read(workspace, id);
      if (!(await this.tasks.storage.readStructuredSpec(workspace, id)) && !hasLegacySpec(await this.tasks.storage.readSpec(workspace, id))) {
        throw new Error("No specification for this memory");
      }
      if (await this.planStorage.read(workspace, id)) throw new Error("Delete the associated plan before deleting its specification");
      await this.tasks.storage.deleteSpec(workspace, id, memory.title);
      delete memory.spec_archived_at;
      memory.updated_at = new Date().toISOString();
      await this.tasks.storage.write(workspace, memory);
      return { deleted: true };
    });
  }

  async archivePlan(workspace: string, id: string, archived: boolean) {
    await this.registry.get(workspace);
    await this.tasks.storage.read(workspace, id);
    return this.plans.setArchived(workspace, id, archived);
  }

  async deletePlan(workspace: string, id: string) {
    await this.registry.get(workspace);
    await this.tasks.storage.read(workspace, id);
    await this.plans.deleteForMemory(workspace, id);
    return { deleted: true };
  }

  async importFromMemory(workspace: string, targetId: string, sourceId: string, options: { notes: boolean; spec: boolean; plan: boolean; plan_archive_id?: string; spec_revision?: number }) {
    await this.registry.get(workspace);
    const reuseSaved = sourceId === targetId;
    if (reuseSaved && (options.notes || !(options.plan && options.plan_archive_id || options.spec && !options.plan && options.spec_revision)))
      throw new Error("Select a saved specification revision or plan to reuse in this memory");
    if (!options.notes && !options.spec && !options.plan) throw new Error("Select notes, specification, or plan to import");
    return this.tasks.storage.workspaceLock(workspace, async () => {
      const source = await this.tasks.storage.read(workspace, sourceId);
      const target = await this.tasks.storage.read(workspace, targetId);
      if (target.archived_at || target.status === "completed") throw new Error("Import into a visible, unfinished memory");
      if (options.plan_archive_id && !options.plan) throw new Error("Select plan import to choose an archived plan");
      const sourcePlan = options.plan_archive_id
        ? (await this.planStorage.historyEntries(workspace, sourceId)).find((entry) => entry.id === options.plan_archive_id)?.plan
        : options.plan ? await this.planStorage.read(workspace, sourceId) : undefined;
      if (options.plan && !sourcePlan) throw new Error("Source memory has no plan");
      const needsSpec = options.spec || options.plan;
      const targetSpec = needsSpec ? await this.tasks.storage.readStructuredSpec(workspace, targetId) : undefined;
      if (needsSpec && targetSpec && !target.spec_archived_at && !reuseSaved) throw new Error("Destination already has a current specification; archive it first");
      const targetPlan = needsSpec ? await this.planStorage.read(workspace, targetId) : undefined;
      if (targetPlan && !targetPlan.archived_at) throw new Error("Destination already has a current plan; archive or delete it before importing a specification or plan");
      const sourceSpec = sourcePlan?.spec_revision
        ? await this.tasks.storage.readSpecRevision(workspace, sourceId, sourcePlan.spec_revision)
        : needsSpec && options.spec_revision ? await this.tasks.storage.readSpecRevision(workspace, sourceId, options.spec_revision)
          : needsSpec ? await this.tasks.storage.readStructuredSpec(workspace, sourceId) : undefined;
      if (needsSpec && !sourceSpec) throw new Error("Source memory has no structured specification");
      if (sourcePlan && (!sourcePlan.spec_revision || structuredSpecHash(sourceSpec!) !== sourcePlan.spec_hash))
        throw new Error("Source plan has no matching structured specification");
      if (options.notes && target.records.length + source.records.length > 500) throw new Error("Import exceeds the destination note limit");
      const now = new Date().toISOString();
      const nextRevision = sourceSpec ? (targetSpec?.revision || 0) + 1 : undefined;
      const importedSpec = sourceSpec && nextRevision ? structuredSpecSchema.parse({ ...sourceSpec, revision: nextRevision,
        reason: `Imported from memory ${sourceId}, specification revision ${sourceSpec.revision}`, created_at: now, archived_at: undefined }) : undefined;
      const importedPlan = sourcePlan && importedSpec ? planStateSchema.parse({ ...sourcePlan, memory_id: targetId,
        spec_hash: structuredSpecHash(importedSpec), spec_revision: importedSpec.revision, revision: 1, status: "suspended", current_step: 0,
        steps: sourcePlan.steps.map((step, index) => ({ ...step, status: index === 0 ? "current" : "pending", mutation_generation: 0,
          writes: step.writes.map((write) => ({ ...write, not_needed_reason: undefined })),
          modified_paths: [], write_baseline: undefined, plan_baseline: undefined, check_receipts: undefined,
          pending_mutation: undefined, pending_shell: undefined, violations: [],
          verification: step.verification.map((item) => ({ ...item, verified_generation: undefined, last_exit: undefined, write_states: undefined })) })),
        repository_baseline: undefined, revisions: [], lifecycle: [{ status: "suspended", reason: `Imported from memory ${sourceId}`, at: now }],
        requirement_exceptions: [], marker_exceptions: [], final_evidence: undefined, review_receipt: undefined,
        last_mutation_at: undefined, archived_at: undefined, archived_previous_status: undefined, suspended_from_final_review: undefined,
        imported_from: { memory_id: sourceId, plan_revision: sourcePlan.revision }, created_at: now, updated_at: now }) : undefined;
      let importedRecords: TaskState["records"] = [];
      if (options.notes) {
        let next = target.next_record_id || Math.max(0, ...target.records.map((item) => Number(item.id.slice(1)) || 0)) + 1;
        importedRecords = source.records.map((record, index) => ({ ...record, id: `M${next++}`, status: "observed" as const,
          evidence_refs: [], reason: `Imported from memory ${sourceId}, record ${record.id}`,
          created_at: new Date(Date.parse(now) + index).toISOString(), updated_at: now,
          archived_at: record.archived_at ? now : undefined }));
        target.records = [...importedRecords, ...target.records]; target.next_record_id = next;
      }
      if (importedSpec) delete target.spec_archived_at;
      target.updated_at = now;
      if (importedPlan && targetPlan) await this.planStorage.archiveTerminal(workspace, targetPlan);
      const archivePreviousSpec = reuseSaved && !!targetSpec && !targetSpec.archived_at;
      await this.tasks.storage.transaction(workspace, targetId, "import-memory-content", async () => {
        for (const record of importedRecords)
          await this.tasks.storage.appendFinding(workspace, targetId, `## ${record.kind[0]!.toUpperCase()}${record.kind.slice(1)} — ${record.created_at}\n\n${record.text}`);
        if (archivePreviousSpec) await this.tasks.storage.writeStructuredSpec(workspace, targetId, { ...targetSpec!, archived_at: now });
        if (importedSpec) await this.tasks.storage.writeStructuredSpec(workspace, targetId, importedSpec);
        if (importedPlan) await atomicWrite(this.planStorage.path(workspace, targetId), `${JSON.stringify(importedPlan, null, 2)}\n`);
        await this.tasks.storage.write(workspace, target);
      }, [
        ...(importedSpec ? [`spec_revision_${importedSpec.revision}`] : []),
        ...(archivePreviousSpec ? [`spec_revision_${targetSpec!.revision}`] : []),
      ]);
      return { imported_notes: options.notes ? source.records.length : 0, spec_revision: importedSpec?.revision, plan_status: importedPlan?.status };
    });
  }

  private async settlePlan(workspace: string, memory: TaskState, decision?: PlanDecision) {
    const plan = await this.planStorage.read(workspace, memory.id);
    if (!plan || !["active", "final_review"].includes(plan.status)) {
      if (plan?.status === "suspended" && decision === "abandon") {
        plan.status = "abandoned"; plan.updated_at = new Date().toISOString();
        plan.lifecycle.push({ status: "abandoned", reason: "Local operator completed memory", at: plan.updated_at });
        await this.planStorage.write(workspace, plan);
      }
      return plan;
    }
    if (!decision) throw new Error("ACTIVE_PLAN_CONFIRMATION_REQUIRED");
    if (plan.status === "final_review" && decision === "suspend") throw new Error("Final review plan must be abandoned before leaving the memory");
    plan.status = decision === "suspend" ? "suspended" : "abandoned";
    plan.updated_at = new Date().toISOString();
    plan.lifecycle.push({ status: plan.status, reason: "Local operator confirmed memory transition", at: plan.updated_at });
    await this.planStorage.write(workspace, plan);
    return plan;
  }

  async activate(workspace: string, id: string, decision?: PlanDecision) {
    await this.registry.get(workspace);
    return this.tasks.storage.workspaceLock(workspace, async () => {
      const all = await this.tasks.list(workspace); const target = all.find((item) => item.id === id);
      if (!target) throw new Error(`Unknown memory: ${id}`);
      if (target.archived_at) throw new Error("Restore this archived memory before activating it");
      if (target.status === "completed") throw new Error("Completed memory cannot be activated");
      const current = all.find((item) => item.status === "active");
      if (current?.id === id) return target;
      const previousPlan = current ? await this.planStorage.read(workspace, current.id) : undefined;
      let stateWriteAttempted = false;
      try {
        if (current) await this.settlePlan(workspace, current, decision);
        const now = new Date().toISOString();
        stateWriteAttempted = true;
        if (current) await this.tasks.storage.write(workspace, { ...current, status: "paused", updated_at: now });
        const active = { ...target, status: "active" as const, updated_at: now };
        await this.tasks.storage.write(workspace, active);
        return active;
      } catch (error) {
        if (stateWriteAttempted) {
          if (current) await this.tasks.storage.write(workspace, current);
          await this.tasks.storage.write(workspace, target);
        }
        if (previousPlan && decision) await this.planStorage.write(workspace, previousPlan);
        throw error;
      }
    });
  }

  async pause(workspace: string, id: string, decision?: PlanDecision) {
    await this.registry.get(workspace);
    return this.tasks.storage.workspaceLock(workspace, async () => {
      const target = await this.tasks.storage.read(workspace, id);
      if (target.status !== "active") throw new Error("Only the active memory can be paused");
      const previousPlan = await this.planStorage.read(workspace, id);
      let stateWriteAttempted = false;
      try {
        await this.settlePlan(workspace, target, decision);
        const state = { ...target, status: "paused" as const, updated_at: new Date().toISOString() };
        stateWriteAttempted = true;
        await this.tasks.storage.write(workspace, state); return state;
      } catch (error) {
        if (stateWriteAttempted) await this.tasks.storage.write(workspace, target);
        if (previousPlan && decision) await this.planStorage.write(workspace, previousPlan);
        throw error;
      }
    });
  }

  async complete(workspace: string, id: string, decision?: PlanDecision) {
    await this.registry.get(workspace);
    return this.tasks.storage.workspaceLock(workspace, async () => {
      const target = await this.tasks.storage.read(workspace, id);
      if (target.status === "completed") throw new Error("Memory is already completed");
      const existingPlan = await this.planStorage.read(workspace, id);
      if (existingPlan && existingPlan.status !== "completed") throw new Error("PLAN_REVIEW_REQUIRED: Complete the plan and its final code review before completing this memory");
      if (existingPlan && (await this.plans.stateForMemory(workspace, id)).stale) throw new Error("PLAN_STALE: The completed plan is bound to an older specification");
      if (existingPlan && !(await this.plans.inspect(workspace, id)).receipt_current) throw new Error("PLAN_REVIEW_REQUIRED: The plan review receipt is missing or stale");
      if (decision === "suspend") throw new Error("Completing memory requires abandoning an open plan");
      const previousPlan = await this.planStorage.read(workspace, id);
      let stateWriteAttempted = false;
      try {
        const plan = await this.settlePlan(workspace, target, decision);
        if (plan?.status === "suspended") throw new Error("Suspended plan must be abandoned before completing memory");
        const now = new Date().toISOString();
        const summary = target.outcome?.summary || target.confirmed_findings.at(-1) || target.objective || target.title;
        const state: TaskState = { ...target, status: "completed", outcome: {
          summary, limitations: target.blockers, evidence_refs: [], modified_paths: plan?.final_evidence?.modified_paths || [],
          verifications: plan?.final_evidence?.verifications || [], provenance_version: 2, completed_at: now }, updated_at: now };
        stateWriteAttempted = true;
        await this.tasks.storage.write(workspace, state); return state;
      } catch (error) {
        if (stateWriteAttempted) await this.tasks.storage.write(workspace, target);
        if (previousPlan && decision) await this.planStorage.write(workspace, previousPlan);
        throw error;
      }
    });
  }

  async planDetail(workspace: string, id: string) {
    await this.registry.get(workspace);
    await this.tasks.read(workspace, id);
    return this.plans.inspect(workspace, id);
  }

  async planTransition(workspace: string, id: string, action: "suspend" | "reactivate" | "abandon", reason?: string) {
    await this.registry.get(workspace);
    return this.plans.transitionForMemory(workspace, id, action === "reactivate" ? "active" : action === "suspend" ? "suspended" : "abandoned", reason);
  }

  async planSetStatus(workspace: string, id: string, status: "active" | "suspended" | "final_review" | "completed" | "abandoned", reason?: string) {
    await this.registry.get(workspace);
    return this.tasks.storage.workspaceLock(workspace, async () => {
      await this.tasks.storage.read(workspace, id);
      const plan = await this.planStorage.read(workspace, id);
      if (!plan) throw new Error("No plan for this memory");
      if (plan.status === status && !plan.archived_at) return plan;
      const now = new Date().toISOString();
      // This control-plane action records an operator choice, not a verified plan completion.
      delete plan.review_receipt;
      delete plan.final_evidence;
      delete plan.archived_at;
      delete plan.archived_previous_status;
      delete plan.suspended_from_final_review;
      if (status === "active" && plan.steps[plan.current_step]?.status !== "current") {
        const next = plan.steps.findIndex((step) => step.status === "current" || step.status === "pending");
        plan.current_step = next >= 0 ? next : plan.steps.length - 1;
        plan.steps[plan.current_step]!.status = "current";
      }
      plan.status = status;
      plan.updated_at = now;
      plan.lifecycle = [...plan.lifecycle, { status, reason: reason?.trim() || "Operator changed plan status via UI", at: now }].slice(-50);
      await this.planStorage.write(workspace, plan);
      return plan;
    });
  }

  async planFinish(workspace: string, id: string) {
    await this.registry.get(workspace);
    const selected = await this.tasks.current(workspace);
    if (selected?.id !== id) throw new Error("Select this memory before finishing its plan");
    return this.plans.complete(workspace);
  }

  async planResolveWrite(workspace: string, id: string, repo: string, file: string, reason: string) {
    await this.registry.get(workspace);
    return this.plans.markWriteNotNeeded(workspace, id, repo, file, reason);
  }

  async planAllowMarker(workspace: string, id: string, repo: string, file: string, reason: string) {
    await this.registry.get(workspace);
    return this.plans.allowFinalMarker(workspace, id, repo, file, reason);
  }

  async phase(workspace: string, id: string, phase: string) {
    await this.registry.get(workspace);
    if (!["investigation", "implementation", "verification", "review"].includes(phase)) throw new Error("Invalid phase");
    return this.tasks.update(workspace, id, { phase });
  }

  async rollback(workspace: string, id: string, revision: number) {
    await this.registry.get(workspace);
    return this.tasks.rollbackSpec(workspace, id, revision, "Rollback initiated by local operator via control plane");
  }
}
