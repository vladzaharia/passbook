/**
 * The quiet gap that lets a reader's burst claim its keys. A reader types a code in a few
 * milliseconds, so a character that has another within the gap is part of a scan, not a shortcut
 * and not type-to-search. A lone character waits out the gap, then acts. The gap is the wedge
 * detector's own `maxGapMs`: one definition of a burst for both.
 *
 * Keys that had company are held, not dropped: if the wedge takes them as a scan they are
 * discarded; if it does not (a fast typist), they are replayed once the wedge has had its say.
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
  private held: string[] = [];
  private replaying: unknown = null;
  private readonly clock: GateClock;
  private readonly gapMs: number;
  private readonly replayMs: number;

  constructor(clock: GateClock, gapMs: number, replayMs: number = gapMs) {
    this.clock = clock;
    this.gapMs = gapMs;
    this.replayMs = replayMs;
  }

  /** A printable key at `t`: `burst` when another came within the gap (the detector's gap is inclusive). */
  printable(t: number = this.clock.now()): 'single' | 'burst' {
    const burst = this.last !== null && t - this.last <= this.gapMs;
    this.last = t;
    this.streak = burst ? this.streak + 1 : 1;
    if (burst) this.cancel();
    return burst ? 'burst' : 'single';
  }

  /** Time since the last printable key; Infinity before the first. */
  sinceLast(t: number = this.clock.now()): number {
    return this.last === null ? Number.POSITIVE_INFINITY : t - this.last;
  }

  /**
   * Enter right behind a run of fast characters ends a reader's code: it is not the primary
   * action. One or two quick keys from a person do not count, so their Enter still acts.
   */
  terminates(t: number = this.clock.now()): boolean {
    const ends = this.streak >= MIN_RUN && this.last !== null && t - this.last <= this.gapMs;
    if (ends) this.cancel();
    return ends;
  }

  /** Run `action` once the gap has passed with no second key. */
  defer(action: () => void): void {
    this.cancel();
    this.pending = this.clock.setTimeout(() => {
      this.pending = null;
      this.dropHeld();
      action();
    }, this.gapMs);
  }

  /** Keep a key that may turn out to be a person's: `replay` gets the run if no scan claims it. */
  hold(ch: string, replay: (text: string) => void): void {
    this.held.push(ch);
    if (this.replaying !== null) this.clock.clearTimeout(this.replaying);
    this.replaying = this.clock.setTimeout(() => {
      this.replaying = null;
      const text = this.held.join('');
      this.held = [];
      if (text.length >= 2) replay(text);
    }, this.replayMs);
  }

  /** A run of keys is waiting to be decided: a scan's code, or a person's word. */
  holding(): boolean {
    return this.held.length > 0;
  }

  /** The person moved on (Esc, a chord): what was held is theirs no longer. */
  drop(): void {
    this.dropHeld();
  }

  /** The wedge took a scan: whatever was held was its code. */
  scanSeen(): void {
    this.dropHeld();
    this.cancel();
  }

  private dropHeld(): void {
    this.held = [];
    if (this.replaying !== null) this.clock.clearTimeout(this.replaying);
    this.replaying = null;
  }

  cancel(): void {
    if (this.pending !== null) this.clock.clearTimeout(this.pending);
    this.pending = null;
  }

  dispose(): void {
    this.cancel();
    this.dropHeld();
  }
}

export const realClock: GateClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (handle) => window.clearTimeout(handle as number),
};
