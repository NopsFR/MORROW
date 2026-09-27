import type { Memory, Project, Task, ToolDescriptor } from "@morrow/schemas";
import type { ProjectRepository } from "@morrow/database";
import type { MemoryService } from "@morrow/memory";
import type { ToolRegistry } from "@morrow/tools";
import type { Clock } from "@morrow/shared";

export interface TaskContext {
  readonly task: Task;
  readonly project: Pick<Project, "id" | "name" | "rootPath"> | null;
  /** Tools the agent may request for this task: registered, available, and usable in scope. */
  readonly tools: readonly ToolDescriptor[];
  /** Active memories relevant to the task's scope. */
  readonly memories: readonly Memory[];
  readonly environment: { readonly platform: string; readonly now: string };
}

const MEMORY_LIMIT = 12;

/**
 * Assembles what the model is told about a task. Everything here comes from
 * MORROW's own state; nothing is inferred or invented.
 */
export class ContextBuilder {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly tools: ToolRegistry,
    private readonly memory: MemoryService,
    private readonly clock: Clock,
  ) {}

  async build(task: Task): Promise<TaskContext> {
    const project = task.projectId ? this.projects.get(task.projectId) : null;
    const hasWorkspace = Boolean(project?.rootPath);

    const usable = this.tools.list().filter((t) => !t.requiresWorkspace || hasWorkspace);
    const descriptors = (await this.tools.describe()).filter(
      (d) => d.availability.status !== "UNAVAILABLE" && usable.some((t) => t.id === d.id),
    );

    const memories = this.memory.retrieve({
      ...(task.projectId ? { projectId: task.projectId, includeGlobal: true } : { projectId: null }),
      limit: MEMORY_LIMIT,
    });

    return {
      task,
      project: project ? { id: project.id, name: project.name, rootPath: project.rootPath } : null,
      tools: descriptors,
      memories,
      environment: { platform: process.platform, now: new Date(this.clock.now()).toISOString() },
    };
  }
}
