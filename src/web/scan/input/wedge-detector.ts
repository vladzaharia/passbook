/**
 * Keyboard-wedge detection by timing (AC 2.4). A pure class: no DOM, no timers. The source feeds it
 * keys with their times and asks it to flush after a quiet spell.
 */

export interface WedgeConfig {
  /** A longer gap starts a new burst. */
  maxGapMs: number;
  /** Mean gap of an accepted burst. */
  maxMeanGapMs: number;
  minLength: number;
  /** No terminator: accept after this much quiet... */
  idleAcceptMs: number;
  /** ...if at least this long... */
  idleMinLength: number;
  /** ...and this fast. */
  idleMaxMeanGapMs: number;
  maxLength: number;
}

export const WEDGE_STANDARD: WedgeConfig = {
  maxGapMs: 80,
  maxMeanGapMs: 50,
  minLength: 4,
  idleAcceptMs: 150,
  idleMinLength: 8,
  idleMaxMeanGapMs: 30,
  maxLength: 1024,
};

/** Bluetooth readers that batch their keys (WF 5). */
export const WEDGE_SLOW: WedgeConfig = {
  maxGapMs: 150,
  maxMeanGapMs: 90,
  minLength: 4,
  idleAcceptMs: 250,
  idleMinLength: 8,
  idleMaxMeanGapMs: 60,
  maxLength: 1024,
};

export type WedgeKey =
  | { k: 'char'; ch: string; t: number }
  | { k: 'end'; key: 'Enter' | 'Tab'; t: number }
  /** Shift, CapsLock: no reset and no character. */
  | { k: 'ignore'; t: number }
  /** Anything else: reset. */
  | { k: 'other'; t: number };

export type WedgeVerdict =
  | { v: 'none' }
  /** Two or more characters and the last gap within `maxGapMs`: callers may preventDefault. */
  | { v: 'burst' }
  /** One character and no second within `maxGapMs`. */
  | { v: 'human'; ch: string }
  | { v: 'scan'; code: string; start: number; end: number; via: 'Enter' | 'Tab' | 'idle' };

const NONE: WedgeVerdict = { v: 'none' };

export class WedgeDetector {
  private chars: string[] = [];
  private start = 0;
  private last = 0;

  private readonly config: WedgeConfig;

  constructor(config: WedgeConfig) {
    this.config = config;
  }

  /** Would a character typed at `t` start a new buffer? */
  startsBuffer(t: number): boolean {
    return this.chars.length === 0 || t - this.last > this.config.maxGapMs;
  }

  reset(): void {
    this.chars = [];
  }

  private meanGap(): number {
    return this.chars.length < 2 ? 0 : (this.last - this.start) / (this.chars.length - 1);
  }

  push(key: WedgeKey): WedgeVerdict {
    switch (key.k) {
      case 'char':
        return this.char(key.ch, key.t);
      case 'end':
        return this.end(key.key, key.t);
      case 'ignore':
        return this.chars.length >= 2 ? { v: 'burst' } : NONE;
      case 'other':
        this.reset();
        return NONE;
    }
  }

  private char(ch: string, t: number): WedgeVerdict {
    if (this.startsBuffer(t)) {
      this.chars = [ch];
      this.start = t;
    } else this.chars.push(ch);
    this.last = t;
    if (this.chars.length > this.config.maxLength) {
      this.reset();
      return NONE;
    }
    return this.chars.length >= 2 ? { v: 'burst' } : NONE;
  }

  private end(key: 'Enter' | 'Tab', t: number): WedgeVerdict {
    const ok =
      this.chars.length >= this.config.minLength &&
      this.meanGap() <= this.config.maxMeanGapMs &&
      t - this.last <= this.config.maxGapMs;
    if (!ok) {
      this.reset();
      return NONE;
    }
    return this.take(key);
  }

  private take(via: 'Enter' | 'Tab' | 'idle'): WedgeVerdict {
    const verdict: WedgeVerdict = {
      v: 'scan',
      code: this.chars.join(''),
      start: this.start,
      end: this.last,
      via,
    };
    this.reset();
    return verdict;
  }

  /** Called `idleAcceptMs` after the last character. */
  flushIdle(t: number): WedgeVerdict {
    const n = this.chars.length;
    if (n === 0 || t - this.last < this.config.idleAcceptMs) return NONE;
    if (n === 1) {
      const ch = this.chars[0] as string;
      this.reset();
      return { v: 'human', ch };
    }
    if (n >= this.config.idleMinLength && this.meanGap() <= this.config.idleMaxMeanGapMs)
      return this.take('idle');
    this.reset();
    return NONE;
  }
}
