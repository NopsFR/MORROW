import type { EventType } from "./catalog";
import type { EventOf, MorrowEvent } from "./envelope";

export type Unsubscribe = () => void;
type Handler = (event: MorrowEvent) => void;

/**
 * In-process fan-out of events that have already been persisted.
 * A failing subscriber never prevents delivery to other subscribers.
 */
export class EventBus {
  private readonly handlers = new Set<Handler>();

  constructor(private readonly onHandlerError: (error: unknown, event: MorrowEvent) => void = () => {}) {}

  subscribe(handler: Handler): Unsubscribe {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  subscribeTo<T extends EventType>(type: T, handler: (event: EventOf<T>) => void): Unsubscribe {
    return this.subscribe((event) => {
      if (event.type === type) handler(event as EventOf<T>);
    });
  }

  publish(event: MorrowEvent): void {
    for (const handler of [...this.handlers]) {
      try {
        handler(event);
      } catch (error) {
        this.onHandlerError(error, event);
      }
    }
  }
}
