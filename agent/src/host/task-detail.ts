import type { Id } from "@morrow/shared";
import type { ModelPurpose } from "@morrow/schemas";
import type { TaskDetail, TaskModel, TaskPlan } from "@morrow/protocol";
import type { Runtime } from "./container";

/**
 * Assemble everything persisted about a task. Every field comes from MORROW's own
 * tables or event log; nothing is derived from model output after the fact.
 */
export function readTaskDetail(rt: Runtime, taskId: Id<"task">): TaskDetail {
  const task = rt.taskService.get(taskId);
  return {
    task,
    project: task.projectId ? rt.repos.projects.get(task.projectId) : null,
    plan: readPlan(rt, taskId),
    steps: rt.repos.taskSteps.listByTask(taskId),
    executions: rt.repos.toolExecutions.listByTask(taskId),
    permissionRequests: rt.repos.permissionRequests.listByTask(taskId),
    observations: rt.repos.observations.listByTask(taskId),
    artifacts: rt.repos.artifacts.listByTask(taskId),
    memories: rt.memoryService
      .list({ taskId, limit: 50 })
      .map((memory) => ({ memory, sources: rt.memoryService.detail(memory.id).sources })),
    models: readModels(rt, taskId),
  };
}

function readPlan(rt: Runtime, taskId: Id<"task">): TaskPlan | null {
  const event = rt.eventLog.list({ taskId, types: ["PLAN_CREATED"] }).at(-1);
  if (!event || event.type !== "PLAN_CREATED") return null;
  return {
    planId: event.payload.planId,
    summary: event.payload.summary,
    successCriteria: event.payload.successCriteria,
    modelId: event.payload.modelId,
    createdAt: event.occurredAt,
  };
}

function readModels(rt: Runtime, taskId: Id<"task">): TaskModel[] {
  const usage = rt.repos.models.usageByTask(taskId);
  const byModel = new Map<string, { purposes: Set<ModelPurpose>; calls: number; failed: number }>();
  for (const u of usage) {
    const entry = byModel.get(u.modelId) ?? { purposes: new Set(), calls: 0, failed: 0 };
    entry.purposes.add(u.purpose as ModelPurpose);
    entry.calls++;
    if (!u.succeeded) entry.failed++;
    byModel.set(u.modelId, entry);
  }
  const models: TaskModel[] = [];
  for (const [modelId, stats] of byModel) {
    const model = rt.modelService.getModel(modelId as Id<"model">);
    if (!model) continue;
    const provider = rt.repos.models.getProvider(model.providerId);
    if (!provider) continue;
    models.push({
      modelId: model.id,
      providerModelId: model.providerModelId,
      displayName: model.displayName,
      locality: model.locality,
      provider: { id: provider.id, displayName: provider.displayName, adapter: provider.adapter },
      purposes: [...stats.purposes],
      calls: stats.calls,
      failedCalls: stats.failed,
    });
  }
  return models;
}
