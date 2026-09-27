/**
 * Runs a function atomically against the persistent store: either every write
 * inside `fn` commits, or none does. Implemented by the database layer.
 */
export interface UnitOfWork {
  run<T>(fn: () => T): T;
}
