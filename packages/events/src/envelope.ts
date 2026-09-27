import { z } from "zod";
import { newId, type Clock, type Id } from "@morrow/shared";
import { EventIdSchema, ProjectIdSchema, TaskIdSchema, TimestampSchema, type Timestamp } from "@morrow/schemas";
import { EVENT_PAYLOADS, EVENT_TYPES, type EventType, type PayloadOf } from "./catalog";

export const EVENT_SCHEMA_VERSION = 1;

/** Who caused an event. Tools and the agent are distinct actors for audit purposes. */
export const EventActorSchema = z.object({
  kind: z.enum(["USER", "AGENT", "SYSTEM", "TOOL"]),
  /** Tool ID, subsystem name, etc. Null when the kind is self-explanatory (USER). */
  id: z.string().nullable(),
});
export type EventActor = z.infer<typeof EventActorSchema>;

const envelopeShape = {
  id: EventIdSchema,
  /** Global, gap-free order assigned by the event log on append. */
  sequence: z.number().int().positive(),
  schemaVersion: z.literal(EVENT_SCHEMA_VERSION),
  occurredAt: TimestampSchema,
  actor: EventActorSchema,
  taskId: TaskIdSchema.nullable(),
  projectId: ProjectIdSchema.nullable(),
  /** Groups events belonging to one logical operation (e.g. one tool execution). */
  correlationId: z.string().nullable(),
  /** The event that directly caused this one, if any. */
  causationId: EventIdSchema.nullable(),
};

export interface EventEnvelope {
  readonly id: Id<"event">;
  readonly sequence: number;
  readonly schemaVersion: typeof EVENT_SCHEMA_VERSION;
  readonly occurredAt: Timestamp;
  readonly actor: EventActor;
  readonly taskId: Id<"task"> | null;
  readonly projectId: Id<"project"> | null;
  readonly correlationId: string | null;
  readonly causationId: Id<"event"> | null;
}

/** A persisted MORROW event, discriminated on `type`. */
export type MorrowEvent = {
  [T in EventType]: EventEnvelope & { readonly type: T; readonly payload: PayloadOf<T> };
}[EventType];

export type EventOf<T extends EventType> = Extract<MorrowEvent, { type: T }>;

const variants = EVENT_TYPES.map((type) =>
  z.object({ ...envelopeShape, type: z.literal(type), payload: EVENT_PAYLOADS[type] }),
);

/** Runtime validator for any MORROW event (used at persistence and IPC boundaries). */
export const MorrowEventSchema = z.discriminatedUnion(
  "type",
  variants as unknown as [(typeof variants)[number], ...(typeof variants)[number][]],
);

export function parseEvent(raw: unknown): MorrowEvent {
  return MorrowEventSchema.parse(raw) as MorrowEvent;
}

/** What a producer supplies; the log assigns id, sequence and time. */
export type EventDraft<T extends EventType = EventType> = {
  [K in T]: {
    readonly type: K;
    readonly payload: PayloadOf<K>;
    readonly actor: EventActor;
    readonly taskId?: Id<"task"> | null;
    readonly projectId?: Id<"project"> | null;
    readonly correlationId?: string | null;
    readonly causationId?: Id<"event"> | null;
  };
}[T];

/**
 * Validate a draft and produce everything except the sequence number.
 * Payloads are validated here so invalid events never reach storage.
 */
export function materializeDraft(draft: EventDraft, clock: Clock): Omit<MorrowEvent, "sequence"> {
  const payload = EVENT_PAYLOADS[draft.type].parse(draft.payload);
  return {
    id: newId("event", clock.now()),
    schemaVersion: EVENT_SCHEMA_VERSION,
    occurredAt: clock.now(),
    type: draft.type,
    payload,
    actor: EventActorSchema.parse(draft.actor),
    taskId: draft.taskId ?? null,
    projectId: draft.projectId ?? null,
    correlationId: draft.correlationId ?? null,
    causationId: draft.causationId ?? null,
  } as Omit<MorrowEvent, "sequence">;
}
