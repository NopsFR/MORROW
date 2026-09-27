import type { Id } from "@morrow/shared";
import type { Task } from "@morrow/schemas";
import type { ModelService } from "@morrow/models";
import type { ToolRegistry } from "@morrow/tools";
import type { Planner } from "../planner";
import type { TaskService } from "./task-service";

const AGENT = { kind: "AGENT", id: null } as const;

/**
 * Drives tasks through their lifecycle. This first version runs only as far as
 * the real system supports:
 *
 *   IDLE → PLANNING → (route a model) →
 *     no model available        → WAITING (NO_MODEL_AVAILABLE)
 *     model, planner fails      → WAITING (planner's reason, e.g. PLANNER_NOT_IMPLEMENTED)
 *     model, planner succeeds   → EXECUTING
 *
 * Execution of planned steps (StepExecutor), verification and recovery loops are
 * wired in once a real planner exists.
 */
export class Orchestrator {
  constructor(
    private readonly tasks: TaskService,
    private readonly models: ModelService,
    private readonly tools: ToolRegistry,
    private readonly planner: Planner,
  ) {}

  async start(taskId: Id<"task">, signal?: AbortSignal): Promise<Task> {
    this.tasks.transition({ taskId, to: "PLANNING", actor: AGENT });

    const route = this.models.route({ capabilities: { toolCalling: true } });
    if (!route.ok) {
      return this.tasks.transition({
        taskId,
        to: "WAITING",
        actor: AGENT,
        reason: { code: "NO_MODEL_AVAILABLE", message: route.message },
      }).task;
    }

    const task = this.tasks.get(taskId);
    const result = await this.planner.plan(
      task,
      { model: route.primary, availableToolIds: this.tools.list().map((t) => t.id) },
      signal,
    );
    if (!result.ok) {
      return this.tasks.transition({ taskId, to: "WAITING", actor: AGENT, reason: result.reason }).task;
    }
    return this.tasks.transition({ taskId, to: "EXECUTING", actor: AGENT }).task;
  }
}
