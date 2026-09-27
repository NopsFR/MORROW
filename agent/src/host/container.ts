import { join } from "node:path";
import { systemClock, type Clock, type Id } from "@morrow/shared";
import { EventBus, EventRecorder } from "@morrow/events";
import {
  MemoryRepository,
  ModelRepository,
  ObservationRepository,
  ProjectRepository,
  SettingsRepository,
  SqliteEventLog,
  SqlitePermissionGrantRepository,
  SqlitePermissionRequestRepository,
  TaskRepository,
  ToolCatalogRepository,
  ToolExecutionRepository,
  openDatabase,
  type MorrowDatabase,
} from "@morrow/database";
import { PermissionAuthority, PermissionEngine, PermissionRequests } from "@morrow/permissions";
import { ToolRegistry, ToolRuntime, filesystemTools } from "@morrow/tools";
import { ModelService, OllamaAdapter, noSecrets, type ModelProviderAdapter } from "@morrow/models";
import { MemoryService } from "@morrow/memory";
import type { ModelAdapterKind } from "@morrow/schemas";
import { TaskService } from "../core/task-service";
import { Orchestrator } from "../core/orchestrator";
import { UnimplementedPlanner } from "../planner";
import { StepExecutor } from "../executor";

export const DATABASE_FILENAME = "morrow.sqlite";

export interface RuntimeConfig {
  readonly dataDir: string;
  readonly migrationsFolder: string;
  readonly clock?: Clock;
  readonly fetch?: typeof fetch;
  readonly onSubscriberError?: (error: unknown) => void;
}

/**
 * Composition root of the agent runtime. This is the only place that knows how
 * the modules fit together; the modules themselves depend on interfaces.
 *
 * Note the split of permission objects: `permissionAuthority` (which can create
 * grants) is exposed only to the host's user-facing RPC handlers. The agent,
 * planner, executor and tools receive the gate (ask-only) or nothing at all.
 */
export function createRuntime(config: RuntimeConfig) {
  const clock = config.clock ?? systemClock;
  const database: MorrowDatabase = openDatabase({
    path: join(config.dataDir, DATABASE_FILENAME),
    migrationsFolder: config.migrationsFolder,
  });
  const { db, uow } = database;

  const bus = new EventBus((error) => config.onSubscriberError?.(error));
  const eventLog = new SqliteEventLog(db, clock);
  const recorder = new EventRecorder(eventLog, bus, uow);

  const repos = {
    projects: new ProjectRepository(db),
    tasks: new TaskRepository(db),
    observations: new ObservationRepository(db),
    memory: new MemoryRepository(db),
    toolCatalog: new ToolCatalogRepository(db),
    toolExecutions: new ToolExecutionRepository(db),
    grants: new SqlitePermissionGrantRepository(db),
    permissionRequests: new SqlitePermissionRequestRepository(db),
    models: new ModelRepository(db),
    settings: new SettingsRepository(db),
  };

  const permissionGate = new PermissionEngine(repos.grants, clock);
  const permissionRequests = new PermissionRequests(repos.permissionRequests, recorder, clock);
  const permissionAuthority = new PermissionAuthority(repos.grants, repos.permissionRequests, recorder, clock);

  const toolRegistry = new ToolRegistry();
  for (const tool of filesystemTools) toolRegistry.register(tool);

  const resolveWorkspaceRoots = (projectId: Id<"project"> | null): string[] => {
    if (!projectId) return [];
    const root = repos.projects.get(projectId)?.rootPath;
    return root ? [root] : [];
  };

  const toolRuntime = new ToolRuntime({
    registry: toolRegistry,
    executions: repos.toolExecutions,
    observations: repos.observations,
    gate: permissionGate,
    permissionRequests,
    recorder,
    bus,
    clock,
    resolveWorkspaceRoots,
  });

  const adapters = new Map<ModelAdapterKind, ModelProviderAdapter>([["OLLAMA", new OllamaAdapter(config.fetch)]]);
  const modelService = new ModelService(repos.models, adapters, noSecrets, clock);
  const taskService = new TaskService(repos.tasks, recorder, clock);
  const memoryService = new MemoryService(repos.memory, recorder, clock);
  const orchestrator = new Orchestrator(taskService, modelService, toolRegistry, new UnimplementedPlanner());
  const stepExecutor = new StepExecutor(taskService, toolRuntime);

  return {
    clock,
    database,
    bus,
    eventLog,
    recorder,
    repos,
    permissionGate,
    permissionRequests,
    permissionAuthority,
    toolRegistry,
    toolRuntime,
    modelService,
    taskService,
    memoryService,
    orchestrator,
    stepExecutor,
    close: () => database.close(),
  };
}

export type Runtime = ReturnType<typeof createRuntime>;
