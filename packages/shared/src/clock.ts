/** Injectable time source so domain logic stays deterministic under test. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };
