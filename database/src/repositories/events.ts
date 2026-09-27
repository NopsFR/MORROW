import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { systemClock, type Clock } from "@morrow/shared";
import { materializeDraft, parseEvent, type EventDraft, type EventLog, type EventQuery, type MorrowEvent } from "@morrow/events";
import type { MorrowDb } from "../client";
import { events } from "../schema";

type EventRow = typeof events.$inferSelect;

function toEvent(row: EventRow): MorrowEvent {
  return parseEvent({
    id: row.id,
    sequence: row.sequence,
    type: row.type,
    schemaVersion: row.schemaVersion,
    occurredAt: row.occurredAt,
    actor: { kind: row.actorKind, id: row.actorId },
    taskId: row.taskId,
    projectId: row.projectId,
    correlationId: row.correlationId,
    causationId: row.causationId,
    payload: row.payload,
  });
}

/** SQLite-backed append-only event log. */
export class SqliteEventLog implements EventLog {
  constructor(
    private readonly db: MorrowDb,
    private readonly clock: Clock = systemClock,
  ) {}

  append(draft: EventDraft): MorrowEvent {
    const event = materializeDraft(draft, this.clock);
    const row = this.db
      .insert(events)
      .values({
        id: event.id,
        type: event.type,
        schemaVersion: event.schemaVersion,
        occurredAt: event.occurredAt,
        actorKind: event.actor.kind,
        actorId: event.actor.id,
        taskId: event.taskId,
        projectId: event.projectId,
        correlationId: event.correlationId,
        causationId: event.causationId,
        payload: event.payload,
      })
      .returning()
      .get();
    return toEvent(row);
  }

  list(query: EventQuery): MorrowEvent[] {
    const conditions = [];
    if (query.taskId) conditions.push(eq(events.taskId, query.taskId));
    if (query.projectId) conditions.push(eq(events.projectId, query.projectId));
    if (query.types && query.types.length > 0) conditions.push(inArray(events.type, [...query.types]));
    if (query.afterSequence !== undefined) conditions.push(gt(events.sequence, query.afterSequence));
    return this.db
      .select()
      .from(events)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(events.sequence))
      .limit(query.limit ?? 500)
      .all()
      .map(toEvent);
  }
}
