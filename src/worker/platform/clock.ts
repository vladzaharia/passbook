/** Time source. Services take a Clock; they never call Date.now() directly. */
export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** Deterministic clock for tests. */
export class ManualClock implements Clock {
  #now: number;
  constructor(start = Date.UTC(2026, 0, 1)) {
    this.#now = start;
  }
  now(): number {
    return this.#now;
  }
  set(ms: number): void {
    this.#now = ms;
  }
  advance(ms: number): number {
    this.#now += ms;
    return this.#now;
  }
}
