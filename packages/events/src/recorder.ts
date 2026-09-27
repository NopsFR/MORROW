import type { UnitOfWork } from "@morrow/shared";
import type { EventBus } from "./bus";
import type { EventDraft, MorrowEvent } from "./envelope";
import type { EventLog } from "./log";

export type Emit = (draft: EventDraft) => MorrowEvent;

/**
 * Couples state changes with the events describing them.
 *
 * `transact` runs `fn` inside a unit of work; events emitted within it are appended
 * to the durable log in the same transaction, and published to subscribers only
 * after the outermost transaction commits. If the transaction rolls back, nothing
 * is published — subscribers never observe events that did not happen.
 */
export class EventRecorder {
  private depth = 0;
  private pending: MorrowEvent[] = [];

  constructor(
    private readonly log: EventLog,
    private readonly bus: EventBus,
    private readonly uow: UnitOfWork,
  ) {}

  transact<T>(fn: (emit: Emit) => T): T {
    const outermost = this.depth === 0;
    this.depth++;
    let result: T;
    try {
      result = this.uow.run(() => fn((draft) => this.append(draft)));
    } catch (error) {
      if (outermost) this.pending = [];
      throw error;
    } finally {
      this.depth--;
    }
    if (outermost) {
      const toPublish = this.pending;
      this.pending = [];
      for (const event of toPublish) this.bus.publish(event);
    }
    return result;
  }

  /** Convenience for recording a single event with no accompanying state change. */
  record(draft: EventDraft): MorrowEvent {
    return this.transact((emit) => emit(draft));
  }

  private append(draft: EventDraft): MorrowEvent {
    const event = this.log.append(draft);
    this.pending.push(event);
    return event;
  }
}
