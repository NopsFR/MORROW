/**
 * Application state for the MORROW shell.
 *
 * The store mirrors the runtime; it is not a second source of truth. Task state,
 * permissions and events come from the runtime and are refreshed when the runtime
 * reports a relevant event. Components read via `useMorrow` and call the actions
 * exported here — they contain no runtime logic themselves.
 */
import { useSyncExternalStore } from "react";
import { TRANSIENT_AMBIENT_MS } from "@morrow/design-system";
import type { MorrowEvent } from "@morrow/events";
import type { Id } from "@morrow/shared";
import {
  INIT_SUBSYSTEMS,
  type InitCheck,
  type InitSubsystem,
  type PermissionRequest,
  type PermissionScope,
  type Task,
} from "@morrow/schemas";
import {
  isNativeAvailable,
  nativeInitChecks,
  onRuntimeEvent,
  onRuntimeStatus,
  request,
  runtimeStatus,
  RequestError,
  type RuntimeStatus,
} from "./bridge";
import { TaskWorkspace, type TaskWorkspaceState } from "./task-workspace";
import { summarizeModels, type ModelSummary } from "./presence";

export type BootPhase = "INITIALIZING" | "READY" | "DEGRADED";
export type HistoryFilter = "ALL" | "OPEN" | "COMPLETED" | "FAILED";

export interface MorrowState {
  readonly native: "detecting" | "available" | "unavailable";
  readonly runtime: RuntimeStatus | null;
  readonly boot: {
    readonly phase: BootPhase;
    readonly checks: Partial<Record<InitSubsystem, InitCheck>>;
    readonly dismissed: boolean;
  };
  readonly tasks: readonly Task[];
  readonly pendingPermissions: readonly PermissionRequest[];
  /** What the models subsystem reports (null until the runtime has answered). */
  readonly models: ModelSummary | null;
  readonly inputFocused: boolean;
  /** Whether the full task history panel is open beside the workspace (view state only). */
  readonly historyOpen: boolean;
  /** Which tasks the history shows (view state only; filters the loaded tasks, never the records). */
  readonly historyFilter: HistoryFilter;
  readonly transient: { readonly state: "FAILED" | "COMPLETED"; readonly until: number } | null;
  /** Last user-facing failure of an action (not of a task). */
  readonly notice: { readonly code: string; readonly message: string } | null;
}

let state: MorrowState = {
  native: "detecting",
  runtime: null,
  boot: { phase: "INITIALIZING", checks: {}, dismissed: false },
  tasks: [],
  pendingPermissions: [],
  models: null,
  inputFocused: false,
  historyOpen: false,
  historyFilter: "ALL",
  transient: null,
  notice: null,
};

const listeners = new Set<() => void>();

function set(update: Partial<MorrowState> | ((s: MorrowState) => Partial<MorrowState>)): void {
  const patch = typeof update === "function" ? update(state) : update;
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

export function getState(): MorrowState {
  return state;
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useMorrow<T>(selector: (s: MorrowState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state), () => selector(state));
}

// ── Initialisation ─────────────────────────────────────────────────────

function recordChecks(checks: readonly InitCheck[]): void {
  set((s) => {
    const next = { ...s.boot.checks };
    for (const c of checks) next[c.subsystem] = c;
    return { boot: { ...s.boot, checks: next } };
  });
}

function unavailableChecks(subsystems: readonly InitSubsystem[], reason: string): InitCheck[] {
  return subsystems.map((subsystem) => ({ subsystem, status: "UNAVAILABLE", summary: reason, details: [] }));
}

function finishBoot(): void {
  const checks = INIT_SUBSYSTEMS.map((s) => state.boot.checks[s]);
  const failed = checks.some((c) => !c || c.status === "FAILED");
  const runtimeDown = state.runtime?.state !== "RUNNING";
  set((s) => ({ boot: { ...s.boot, phase: failed || runtimeDown ? "DEGRADED" : "READY" } }));
}

async function waitForRuntime(timeoutMs: number): Promise<RuntimeStatus> {
  const deadline = Date.now() + timeoutMs;
  let status = await runtimeStatus();
  while ((status.state === "STARTING" || status.state === "NOT_STARTED") && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    status = await runtimeStatus();
  }
  return status;
}

const RUNTIME_SUBSYSTEMS: readonly InitSubsystem[] = ["DATABASE", "MEMORY", "MODELS", "TOOLS", "SECURITY"];
let initialised = false;

export async function initialize(): Promise<void> {
  if (initialised) return;
  initialised = true;

  if (!isNativeAvailable()) {
    set({ native: "unavailable", runtime: null });
    recordChecks(
      unavailableChecks(INIT_SUBSYSTEMS, "Native layer unavailable — MORROW is running outside its desktop shell"),
    );
    finishBoot();
    return;
  }
  set({ native: "available" });

  await onRuntimeStatus((runtime) => set({ runtime }));
  await onRuntimeEvent(handleEvent);

  try {
    recordChecks(await nativeInitChecks());
  } catch (error) {
    recordChecks(unavailableChecks(["ENVIRONMENT", "COMPUTER"], describe(error)));
  }

  const runtime = await waitForRuntime(15_000);
  set({ runtime });
  if (runtime.state !== "RUNNING") {
    const reason = runtime.state === "UNAVAILABLE" ? runtime.reason : `Agent runtime ${runtime.state.toLowerCase()}`;
    recordChecks(unavailableChecks(RUNTIME_SUBSYSTEMS, reason).map((c) => ({ ...c, status: "FAILED" as const })));
    finishBoot();
    return;
  }

  try {
    const { checks } = await request("system.initialize");
    recordChecks(checks);
  } catch (error) {
    recordChecks(unavailableChecks(RUNTIME_SUBSYSTEMS, describe(error)).map((c) => ({ ...c, status: "FAILED" as const })));
  }
  await Promise.all([refreshTasks(), refreshPermissions(), refreshModels()]);
  // Open the most recent task that still needs attention, if any.
  const open = state.tasks.find((t) => !["COMPLETED", "FAILED", "CANCELLED"].includes(t.status));
  if (open) void taskWorkspace.select(open.id);
  finishBoot();
}

// ── Selected task ──────────────────────────────────────────────────

/** Read-through view of the selected task, refreshed by the live event stream. */
export const taskWorkspace = new TaskWorkspace({ request });

export function useTaskWorkspace(): TaskWorkspaceState {
  return useSyncExternalStore(taskWorkspace.subscribe, taskWorkspace.getState, taskWorkspace.getState);
}

export function selectTask(taskId: Id<"task"> | null): void {
  void taskWorkspace.select(taskId);
}

export async function pauseTask(taskId: Id<"task">): Promise<void> {
  await act(() => request("task.pause", { taskId }));
  await refreshTasks();
}

export function dismissBoot(): void {
  set((s) => ({ boot: { ...s.boot, dismissed: true } }));
}

// ── Runtime events ─────────────────────────────────────────────────────

let taskRefresh: ReturnType<typeof setTimeout> | null = null;

function handleEvent(event: MorrowEvent): void {
  taskWorkspace.handleEvent(event);
  if (event.type.startsWith("TASK_")) {
    // Coalesce bursts of lifecycle events into one refresh.
    if (taskRefresh) clearTimeout(taskRefresh);
    taskRefresh = setTimeout(() => void refreshTasks(), 50);
  }
  if (event.type === "TOOL_PERMISSION_REQUIRED" || event.type === "PERMISSION_RESOLVED") void refreshPermissions();
  if (event.type === "TASK_FAILED" || event.type === "TOOL_FAILED") pulse("FAILED");
  if (event.type === "TASK_COMPLETED") pulse("COMPLETED");
}

function pulse(kind: "FAILED" | "COMPLETED"): void {
  const ms = TRANSIENT_AMBIENT_MS[kind] ?? 1000;
  set({ transient: { state: kind, until: Date.now() + ms } });
  setTimeout(() => set({ transient: null }), ms + 20);
}

export async function refreshTasks(): Promise<void> {
  try {
    set({ tasks: await request("task.list", { limit: 50 }) });
  } catch (error) {
    report(error);
  }
}

/**
 * Mirror what the models subsystem reports. `probe` asks providers again (as the
 * Models view's "Check again" does); otherwise the runtime's current view is read.
 */
export async function refreshModels(probe = false): Promise<void> {
  try {
    set({ models: summarizeModels(await request(probe ? "models.refresh" : "models.status")) });
  } catch (error) {
    report(error);
  }
}

export async function refreshPermissions(): Promise<void> {
  try {
    set({ pendingPermissions: await request("permission.listPending") });
  } catch (error) {
    report(error);
  }
}

// ── User actions ───────────────────────────────────────────────────────

export async function submitObjective(objective: string, projectId: Id<"project"> | null): Promise<boolean> {
  const text = objective.trim();
  if (!text) return false;
  try {
    const task = await request("task.create", { objective: text, ...(projectId ? { projectId } : {}) });
    set((s) => ({ tasks: [task, ...s.tasks.filter((t) => t.id !== task.id)], notice: null }));
    void taskWorkspace.select(task.id);
    return true;
  } catch (error) {
    report(error);
    return false;
  }
}

export async function cancelTask(taskId: Id<"task">): Promise<void> {
  await act(() => request("task.cancel", { taskId }));
  await refreshTasks();
}

export async function resumeTask(taskId: Id<"task">): Promise<void> {
  await act(() => request("task.resume", { taskId }));
  await refreshTasks();
}

export async function respondToPermission(
  requestId: Id<"permissionRequest">,
  decision: "ALLOW" | "DENY",
  scope: PermissionScope,
): Promise<void> {
  await act(() => request("permission.respond", { requestId, decision, scope }));
  await refreshPermissions();
}

export function setInputFocused(inputFocused: boolean): void {
  if (state.inputFocused !== inputFocused) set({ inputFocused });
}

export function setHistoryOpen(historyOpen: boolean): void {
  if (state.historyOpen !== historyOpen) set({ historyOpen });
}

/** Open the history showing one kind of task (e.g. from a count in the workspace). */
export function showHistory(historyFilter: HistoryFilter): void {
  set({ historyOpen: true, historyFilter });
}

export function setHistoryFilter(historyFilter: HistoryFilter): void {
  if (state.historyFilter !== historyFilter) set({ historyFilter });
}

export function clearNotice(): void {
  set({ notice: null });
}

async function act(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    set({ notice: null });
  } catch (error) {
    report(error);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function report(error: unknown): void {
  const code = error instanceof RequestError ? error.code : "ERROR";
  set({ notice: { code, message: describe(error) } });
}
