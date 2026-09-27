/**
 * The selected task, as the runtime reports it.
 *
 * This is a read-through view, not a second task engine: it holds the runtime's
 * latest `task.detail` for one task plus that task's event log, and re-reads both
 * whenever the live event stream reports activity for the task. It never infers
 * or advances task state itself. Events are fetched incrementally by sequence, so
 * a missed stream notification is healed by the next refresh.
 */
import type { Id } from "@morrow/shared";
import type { MorrowEvent } from "@morrow/events";
import type { PermissionScope } from "@morrow/schemas";
import type { RpcMethod, RpcParams, RpcResult, TaskDetail } from "@morrow/protocol";

export interface RuntimeClient {
  request<M extends RpcMethod>(method: M, params?: RpcParams<M>): Promise<RpcResult<M>>;
}

export interface TaskWorkspaceState {
  readonly selectedTaskId: Id<"task"> | null;
  readonly detail: TaskDetail | null;
  readonly events: readonly MorrowEvent[];
  readonly status: "empty" | "loading" | "ready" | "error";
  readonly error: string | null;
}

const EMPTY: TaskWorkspaceState = { selectedTaskId: null, detail: null, events: [], status: "empty", error: null };

export class TaskWorkspace {
  private state: TaskWorkspaceState = EMPTY;
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private dirty = false;

  constructor(
    private readonly client: RuntimeClient,
    private readonly coalesceMs = 40,
  ) {}

  getState = (): TaskWorkspaceState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async select(taskId: Id<"task"> | null): Promise<void> {
    if (taskId === this.state.selectedTaskId) return;
    this.set(taskId ? { ...EMPTY, selectedTaskId: taskId, status: "loading" } : EMPTY);
    if (taskId) await this.refresh();
  }

  /** Feed from the live event stream. Only activity on the selected task matters here. */
  handleEvent(event: MorrowEvent): void {
    if (!this.state.selectedTaskId || event.taskId !== this.state.selectedTaskId) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh();
    }, this.coalesceMs);
  }

  /** Re-read the selected task from the runtime. Concurrent calls collapse into one follow-up. */
  refresh(): Promise<void> {
    if (this.inFlight) {
      this.dirty = true;
      return this.inFlight;
    }
    this.inFlight = this.load().finally(() => {
      this.inFlight = null;
      if (this.dirty) {
        this.dirty = false;
        void this.refresh();
      }
    });
    return this.inFlight;
  }

  /** Resolves once no refresh is scheduled or running (used by tests and after actions). */
  async settled(): Promise<void> {
    while (this.timer || this.inFlight) {
      if (this.inFlight) await this.inFlight;
      else await new Promise((r) => setTimeout(r, this.coalesceMs + 5));
    }
  }

  // ── User decisions surfaced in the task view ─────────────────────

  async respondToPermission(
    requestId: Id<"permissionRequest">,
    decision: "ALLOW" | "DENY",
    scope: PermissionScope,
  ): Promise<void> {
    await this.client.request("permission.respond", { requestId, decision, scope });
    await this.refresh();
  }

  async acceptMemory(memoryId: Id<"memory">): Promise<void> {
    await this.client.request("memory.accept", { memoryId });
    await this.refresh();
  }

  async rejectMemory(memoryId: Id<"memory">, reason: string): Promise<void> {
    await this.client.request("memory.reject", { memoryId, reason });
    await this.refresh();
  }

  // ── internals ─────────────────────────────────────────────────────

  private async load(): Promise<void> {
    const taskId = this.state.selectedTaskId;
    if (!taskId) return;
    const lastSequence = this.state.events.at(-1)?.sequence ?? 0;
    try {
      const [detail, newer] = await Promise.all([
        this.client.request("task.detail", { taskId }),
        this.client.request("events.list", { taskId, afterSequence: lastSequence, limit: 1000 }),
      ]);
      if (this.state.selectedTaskId !== taskId) return; // selection changed while loading
      const known = new Set(this.state.events.map((e) => e.sequence));
      const events = [...this.state.events, ...(newer as MorrowEvent[]).filter((e) => !known.has(e.sequence))].sort(
        (a, b) => a.sequence - b.sequence,
      );
      this.set({ selectedTaskId: taskId, detail, events, status: "ready", error: null });
    } catch (error) {
      if (this.state.selectedTaskId !== taskId) return;
      this.set({ ...this.state, status: "error", error: error instanceof Error ? error.message : String(error) });
    }
  }

  private set(next: TaskWorkspaceState): void {
    this.state = next;
    for (const l of this.listeners) l();
  }
}
