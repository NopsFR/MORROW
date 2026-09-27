import { MorrowError, newId, type Clock, type Id } from "@morrow/shared";
import type { EventRecorder, Emit } from "@morrow/events";
import type {
  Memory,
  MemoryActor,
  MemoryOrigin,
  MemoryRelation,
  MemoryRelationKind,
  MemoryRevision,
  MemorySource,
  MemorySourceKind,
  MemoryStatus,
  MemoryType,
} from "@morrow/schemas";
import type { MemoryQuery, MemoryRepository } from "@morrow/database";

/** Default lifetime of WORKING memory when the caller gives none: 24h. */
export const WORKING_MEMORY_TTL_MS = 24 * 60 * 60 * 1000;

export interface EvidenceInput {
  readonly kind: MemorySourceKind;
  readonly ref: string | null;
  readonly excerpt?: string | null;
}

export interface NewMemoryInput {
  readonly type: MemoryType;
  readonly content: string;
  readonly origin: MemoryOrigin;
  readonly confidence: number;
  readonly projectId?: Id<"project"> | null;
  readonly taskId?: Id<"task"> | null;
  readonly expiresAt?: number | null;
  /** Provenance. Required for anything not stated directly by the user. */
  readonly evidence: readonly EvidenceInput[];
}

export interface MemoryDetail {
  readonly memory: Memory;
  readonly sources: MemorySource[];
  readonly relations: MemoryRelation[];
  readonly history: MemoryRevision[];
}

const ACTOR_KIND: Record<MemoryActor, "USER" | "AGENT" | "SYSTEM"> = { USER: "USER", AGENT: "AGENT", SYSTEM: "SYSTEM" };

/**
 * MORROW's durable memory. Memory is not the model's context window and not a
 * transcript dump: each memory is a discrete, typed claim with provenance, a
 * confidence, a lifecycle, and an append-only revision history.
 *
 * - Agent-originated memories start PROPOSED and only become ACTIVE when accepted.
 * - Corrections create a new revision; nothing is silently overwritten.
 * - Forgetting erases content from the memory, its history and its evidence excerpts.
 */
export class MemoryService {
  constructor(
    private readonly repo: MemoryRepository,
    private readonly recorder: EventRecorder,
    private readonly clock: Clock,
  ) {}

  /** Record a memory the agent (or a process) proposes. It is not retrievable until accepted. */
  propose(input: NewMemoryInput, actor: MemoryActor = "AGENT"): Memory {
    if (input.evidence.length === 0) {
      throw new MorrowError("MEMORY_WITHOUT_EVIDENCE", "Proposed memories must cite evidence");
    }
    return this.recorder.transact((emit) => {
      const memory = this.insert(input, "PROPOSED", actor, "Proposed");
      emit({
        type: "MEMORY_PROPOSED",
        actor: { kind: ACTOR_KIND[actor], id: null },
        taskId: memory.taskId,
        projectId: memory.projectId,
        payload: { memoryId: memory.id, type: memory.type, origin: memory.origin },
      });
      return memory;
    });
  }

  /** Something the user told MORROW directly. Active immediately; the user is the evidence. */
  rememberFromUser(input: Omit<NewMemoryInput, "origin" | "evidence"> & { evidence?: readonly EvidenceInput[] }): Memory {
    return this.recorder.transact((emit) => {
      const memory = this.insert(
        { ...input, origin: "USER_STATED", evidence: input.evidence ?? [{ kind: "USER", ref: null }] },
        "ACTIVE",
        "USER",
        "Stated by user",
      );
      this.emitCreated(emit, memory, "USER");
      return memory;
    });
  }

  accept(memoryId: Id<"memory">, actor: MemoryActor = "USER"): Memory {
    return this.recorder.transact((emit) => {
      const memory = this.requireStatus(memoryId, ["PROPOSED"]);
      const next = this.revise(memory, { status: "ACTIVE" }, "Accepted", actor);
      this.emitCreated(emit, next, actor);
      return next;
    });
  }

  reject(memoryId: Id<"memory">, reason: string, actor: MemoryActor = "USER"): Memory {
    return this.recorder.transact((emit) => {
      const memory = this.requireStatus(memoryId, ["PROPOSED"]);
      const next = this.revise(memory, { status: "REJECTED" }, reason, actor);
      this.emitUpdated(emit, next, "STATUS_CHANGED", actor);
      return next;
    });
  }

  correct(
    memoryId: Id<"memory">,
    change: { content: string; confidence?: number; evidence?: readonly EvidenceInput[] },
    reason: string,
    actor: MemoryActor,
  ): Memory {
    return this.recorder.transact((emit) => {
      const memory = this.requireStatus(memoryId, ["ACTIVE", "PROPOSED"]);
      const next = this.revise(
        memory,
        { content: change.content.trim(), confidence: change.confidence ?? memory.confidence },
        reason,
        actor,
      );
      for (const evidence of change.evidence ?? []) this.addSource(next.id, evidence);
      this.emitUpdated(emit, next, "CORRECTED", actor);
      return next;
    });
  }

  /** Confirm a memory still holds (e.g. re-observed). Updates lastVerifiedAt and optionally confidence. */
  verify(memoryId: Id<"memory">, evidence: EvidenceInput, confidence?: number, actor: MemoryActor = "SYSTEM"): Memory {
    return this.recorder.transact((emit) => {
      const memory = this.requireStatus(memoryId, ["ACTIVE"]);
      this.addSource(memory.id, evidence);
      const next = this.revise(
        memory,
        { lastVerifiedAt: this.clock.now(), confidence: confidence ?? memory.confidence },
        "Verified",
        actor,
      );
      this.emitUpdated(emit, next, "VERIFIED", actor);
      return next;
    });
  }

  /** Replace `oldId` with a new memory, linking them with a SUPERSEDES relation. */
  supersede(oldId: Id<"memory">, replacement: NewMemoryInput, actor: MemoryActor): Memory {
    return this.recorder.transact((emit) => {
      const old = this.requireStatus(oldId, ["ACTIVE"]);
      const created = this.insert(replacement, "ACTIVE", actor, `Supersedes ${oldId}`);
      this.relate(created.id, old.id, "SUPERSEDES");
      const retired = this.revise(old, { status: "SUPERSEDED" }, `Superseded by ${created.id}`, actor);
      this.emitCreated(emit, created, actor);
      this.emitUpdated(emit, retired, "STATUS_CHANGED", actor);
      return created;
    });
  }

  /**
   * Forget: erase the content everywhere MORROW stored it (memory, revisions,
   * evidence excerpts). A tombstone remains so the forgetting itself is auditable.
   */
  forget(memoryId: Id<"memory">, reason: string, actor: MemoryActor = "USER"): Memory {
    return this.recorder.transact((emit) => {
      const memory = this.repo.get(memoryId);
      if (!memory) throw new MorrowError("MEMORY_NOT_FOUND", "Memory not found");
      if (memory.status === "FORGOTTEN") return memory;
      this.repo.redactRevisions(memory.id);
      this.repo.redactSources(memory.id);
      const next = this.revise(memory, { status: "FORGOTTEN", content: "" }, reason, actor);
      this.emitUpdated(emit, next, "FORGOTTEN", actor);
      return next;
    });
  }

  relate(fromId: Id<"memory">, toId: Id<"memory">, kind: MemoryRelationKind): MemoryRelation {
    const relation: MemoryRelation = {
      id: newId("memoryRelation", this.clock.now()),
      fromMemoryId: fromId,
      toMemoryId: toId,
      kind,
      createdAt: this.clock.now(),
    };
    this.repo.insertRelation(relation);
    return relation;
  }

  /** Retrieve active, unexpired memories. Lexical matching only (see docs: retrieval). */
  retrieve(query: Omit<MemoryQuery, "statuses" | "notExpiredAt">): Memory[] {
    return this.repo.query({ ...query, statuses: ["ACTIVE"], notExpiredAt: this.clock.now() });
  }

  list(query: MemoryQuery): Memory[] {
    return this.repo.query(query);
  }

  detail(memoryId: Id<"memory">): MemoryDetail {
    const memory = this.repo.get(memoryId);
    if (!memory) throw new MorrowError("MEMORY_NOT_FOUND", "Memory not found");
    return {
      memory,
      sources: this.repo.listSources(memoryId),
      relations: this.repo.listRelations(memoryId),
      history: this.repo.listRevisions(memoryId),
    };
  }

  count(): number {
    return this.repo.count();
  }

  // ── internals ──────────────────────────────────────────────────────

  private insert(input: NewMemoryInput, status: MemoryStatus, actor: MemoryActor, reason: string): Memory {
    const content = input.content.trim();
    if (content.length === 0) throw new MorrowError("MEMORY_EMPTY", "Memory content must not be empty");
    const now = this.clock.now();
    const memory: Memory = {
      id: newId("memory", now),
      type: input.type,
      status,
      content,
      origin: input.origin,
      confidence: input.confidence,
      projectId: input.projectId ?? null,
      taskId: input.taskId ?? null,
      createdAt: now,
      updatedAt: now,
      lastVerifiedAt: null,
      expiresAt: input.expiresAt ?? (input.type === "WORKING" ? now + WORKING_MEMORY_TTL_MS : null),
      revision: 1,
    };
    if (memory.type === "WORKING" && memory.taskId === null) {
      throw new MorrowError("WORKING_MEMORY_NEEDS_TASK", "Working memory must belong to a task");
    }
    this.repo.insert(memory);
    for (const evidence of input.evidence) this.addSource(memory.id, evidence);
    this.appendRevision(memory, reason, actor);
    return memory;
  }

  private revise(memory: Memory, change: Partial<Memory>, reason: string, actor: MemoryActor): Memory {
    const next: Memory = { ...memory, ...change, revision: memory.revision + 1, updatedAt: this.clock.now() };
    this.repo.update(next);
    this.appendRevision(next, reason, actor);
    return next;
  }

  private appendRevision(memory: Memory, reason: string, actor: MemoryActor): void {
    this.repo.insertRevision({
      id: newId("memoryRevision", this.clock.now()),
      memoryId: memory.id,
      revision: memory.revision,
      content: memory.content,
      status: memory.status,
      confidence: memory.confidence,
      reason,
      actor,
      createdAt: this.clock.now(),
    });
  }

  private addSource(memoryId: Id<"memory">, evidence: EvidenceInput): void {
    this.repo.insertSource({
      id: newId("memorySource", this.clock.now()),
      memoryId,
      kind: evidence.kind,
      ref: evidence.ref,
      excerpt: evidence.excerpt ?? null,
      createdAt: this.clock.now(),
    });
  }

  private requireStatus(memoryId: Id<"memory">, allowed: readonly MemoryStatus[]): Memory {
    const memory = this.repo.get(memoryId);
    if (!memory) throw new MorrowError("MEMORY_NOT_FOUND", "Memory not found");
    if (!allowed.includes(memory.status)) {
      throw new MorrowError("MEMORY_INVALID_STATE", `Memory is ${memory.status}`, { allowed });
    }
    return memory;
  }

  private emitCreated(emit: Emit, memory: Memory, actor: MemoryActor): void {
    emit({
      type: "MEMORY_CREATED",
      actor: { kind: ACTOR_KIND[actor], id: null },
      taskId: memory.taskId,
      projectId: memory.projectId,
      payload: { memoryId: memory.id, type: memory.type },
    });
  }

  private emitUpdated(
    emit: Emit,
    memory: Memory,
    change: "CORRECTED" | "VERIFIED" | "STATUS_CHANGED" | "FORGOTTEN",
    actor: MemoryActor,
  ): void {
    emit({
      type: "MEMORY_UPDATED",
      actor: { kind: ACTOR_KIND[actor], id: null },
      taskId: memory.taskId,
      projectId: memory.projectId,
      payload: { memoryId: memory.id, revision: memory.revision, change, status: memory.status },
    });
  }
}
