import type { Id } from "@morrow/shared";
import type { EventType } from "./catalog";
import type { EventDraft, MorrowEvent } from "./envelope";

export interface EventQuery {
  readonly taskId?: Id<"task"> | undefined;
  readonly projectId?: Id<"project"> | undefined;
  readonly types?: readonly EventType[] | undefined;
  /** Return events with sequence strictly greater than this. */
  readonly afterSequence?: number | undefined;
  readonly limit?: number | undefined;
}

/**
 * Append-only, durable event log. Implementations must assign strictly increasing
 * sequence numbers and must never mutate or delete appended events.
 */
export interface EventLog {
  append(draft: EventDraft): MorrowEvent;
  list(query: EventQuery): MorrowEvent[];
}
