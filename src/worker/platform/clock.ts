/** Time source. Services take a Clock; they never call Date.now() directly. */
export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
  /** Resolves after `ms`. A test clock resolves at once; a clock without it waits for real. */
  sleep?(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Deterministic clock for tests. */
export class ManualClock implements Clock {
  #now: number;
  constructor(start = Date.UTC(2026, 0, 1)) {
    this.#now = start;
  }
  now(): number {
    return this.#now;
  }
  /** No waiting in tests, and no time passing either: a test that wants it advances the clock itself. */
  async sleep(_ms: number): Promise<void> {}
  set(ms: number): void {
    this.#now = ms;
  }
  advance(ms: number): number {
    this.#now += ms;
    return this.#now;
  }
}
