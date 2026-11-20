/**
 * The quiet gap that lets a reader's burst claim its keys. A reader types a code in a few
 * milliseconds, so a character that has another within the gap is part of a scan, not a shortcut
 * and not type-to-search. A lone character waits out the gap, then acts. The gap is the wedge
 * detector's own `maxGapMs`: one definition of a burst for both.
 */
export interface GateClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Fast characters before an Enter that end a code. The wedge detector asks four for a scan. */
const MIN_RUN = 3;

export class QuietGate {
  private last: number | null = null;
  /** Printable keys in a row, each inside the gap of the one before. */
  private streak = 0;
  private pending: unknown = null;

  private readonly clock: GateClock;
  private readonly gapMs: number;

  constructor(clock: GateClock, gapMs: number) {
    this.clock = clock;
    this.gapMs = gapMs;
  }

  /** A printable key: `burst` when another came within the gap. The pending key is dropped. */
  printable(): 'single' | 'burst' {
    const t = this.clock.now();
    const burst = this.last !== null && t - this.last < this.gapMs;
    this.last = t;
    this.streak = burst ? this.streak + 1 : 1;
    if (burst) this.cancel();
    return burst ? 'burst' : 'single';
  }

  /**
   * Enter right behind a run of fast characters ends a reader's code: it is not the primary
   * action. One or two quick keys from a person do not count, so their Enter still acts.
   */
  terminates(): boolean {
    const ends =
      this.streak >= MIN_RUN && this.last !== null && this.clock.now() - this.last < this.gapMs;
    if (ends) this.cancel();
    return ends;
  }

  /** Run `action` once the gap has passed with no second key. */
  defer(action: () => void): void {
    this.cancel();
    this.pending = this.clock.setTimeout(() => {
      this.pending = null;
      action();
    }, this.gapMs);
  }

  cancel(): void {
    if (this.pending !== null) this.clock.clearTimeout(this.pending);
    this.pending = null;
  }
}

export const realClock: GateClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (handle) => window.clearTimeout(handle as number),
};
