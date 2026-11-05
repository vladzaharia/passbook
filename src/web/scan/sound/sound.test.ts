import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPlayer } from './player.ts';
import { GARNISH, TONES } from './tones.ts';

interface Param {
  value: number;
  calls: [string, ...number[]][];
  setValueAtTime: (...a: number[]) => void;
  linearRampToValueAtTime: (...a: number[]) => void;
  exponentialRampToValueAtTime: (...a: number[]) => void;
  cancelScheduledValues: (...a: number[]) => void;
}
const param = (): Param => {
  const p: Param = {
    value: 0,
    calls: [],
    setValueAtTime: (...a) => p.calls.push(['set', ...a]),
    linearRampToValueAtTime: (...a) => p.calls.push(['lin', ...a]),
    exponentialRampToValueAtTime: (...a) => p.calls.push(['exp', ...a]),
    cancelScheduledValues: (...a) => p.calls.push(['cancel', ...a]),
  };
  return p;
};

class FakeContext {
  static all: FakeContext[] = [];
  currentTime = 10;
  outputLatency: number | undefined = 0.05;
  baseLatency = 0.01;
  state = 'running';
  destination = {};
  oscs: { type: string; frequency: Param; start: number; stop: number }[] = [];
  gains: Param[] = [];
  filters: { type: string; frequency: { value: number } }[] = [];
  resume = vi.fn(async () => {
    this.state = 'running';
  });
  suspend = vi.fn(async () => {
    this.state = 'suspended';
  });
  options: unknown;
  constructor(options?: unknown) {
    this.options = options;
    FakeContext.all.push(this);
  }
  createOscillator() {
    const rec = { type: '', frequency: param(), start: -1, stop: -1 };
    this.oscs.push(rec);
    const node = {
      connect: (n: unknown) => n,
      onended: null as null | (() => void),
      start: (t: number) => {
        rec.start = t;
      },
      stop: (t: number) => {
        rec.stop = t;
      },
      frequency: rec.frequency,
      set type(v: string) {
        rec.type = v;
      },
    };
    return node;
  }
  createBiquadFilter() {
    const f = { type: '', frequency: { value: 0 }, connect: (n: unknown) => n };
    this.filters.push(f);
    return f;
  }
  createGain() {
    const g = { gain: param(), connect: (n: unknown) => n, disconnect: () => {} };
    this.gains.push(g.gain);
    return g;
  }
}

const gains = () => FakeContext.all[0]?.gains ?? [];

beforeEach(() => {
  FakeContext.all = [];
  vi.stubGlobal('AudioContext', FakeContext);
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('sound', () => {
  it('unlock creates the context once, interactive, and resumes a suspended one', () => {
    const s = createPlayer();
    s.unlock();
    s.unlock();
    expect(FakeContext.all).toHaveLength(1);
    expect(FakeContext.all[0]?.options).toEqual({ latencyHint: 'interactive' });
    const ctx = FakeContext.all[0] as FakeContext;
    ctx.state = 'interrupted';
    s.unlock();
    expect(ctx.resume).toHaveBeenCalled();
  });

  it('sets the audio session to playback when present', () => {
    const nav = { audioSession: { type: 'auto' } };
    vi.stubGlobal('navigator', nav);
    createPlayer().unlock();
    expect(nav.audioSession.type).toBe('playback');
  });

  it('suspends when the page is hidden', () => {
    const s = createPlayer();
    s.unlock();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(FakeContext.all[0]?.suspend).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('play schedules each note at currentTime, low-passed, and stops it 20 ms late', () => {
    const s = createPlayer();
    s.unlock();
    s.play('heads_up');
    const ctx = FakeContext.all[0] as FakeContext;
    expect(ctx.oscs).toHaveLength(2);
    expect(ctx.oscs.map((o) => o.type)).toEqual(['triangle', 'triangle']);
    expect(ctx.oscs[0]?.start).toBeCloseTo(10);
    expect(ctx.oscs[1]?.start).toBeCloseTo(10.15);
    expect(ctx.oscs[0]?.stop).toBeCloseTo(10 + 0.09 + 0.02);
    expect(ctx.filters.every((f) => f.type === 'lowpass' && f.frequency.value === 2400)).toBe(true);
  });

  it('glides the first 60 ms of a rising note', () => {
    const s = createPlayer();
    s.unlock();
    s.play('ok');
    const f = (FakeContext.all[0] as FakeContext).oscs[0]?.frequency;
    expect(f?.calls).toContainEqual(['exp', 1568, 10.06]);
  });

  it('plays every tone with notes inside its stated total', () => {
    const totals = {
      ok: 110,
      reward: 300,
      heads_up: 240,
      refused: 370,
      system: 240,
      undo: 60,
      read: 25,
    };
    for (const [name, total] of Object.entries(totals))
      expect(Math.max(...TONES[name as keyof typeof TONES].map((n) => n[3] + n[4]))).toBe(total);
  });

  it('garnishes land at the impact time minus the output latency, else the base latency', () => {
    const s = createPlayer();
    s.unlock();
    s.play('ok', { garnish: 'thump' });
    const ctx = FakeContext.all[0] as FakeContext;
    expect(ctx.oscs).toHaveLength(2);
    expect(ctx.oscs[1]?.start).toBeCloseTo(10 + 0.35 - 0.05);
    ctx.outputLatency = undefined;
    s.play('ok', { garnish: 'click', at: 200 });
    expect(ctx.oscs[3]?.start).toBeCloseTo(10 + 0.2 - 0.01);
    expect(GARNISH.click[0]).toBe('square');
    expect(ctx.filters.some((f) => f.frequency.value === 6000)).toBe(true);
  });

  it('cut ramps every live gain to zero and stops the notes', () => {
    const s = createPlayer();
    s.unlock();
    s.play('reward');
    s.cut();
    const live = gains().slice(1);
    expect(live.length).toBe(3);
    for (const g of live) {
      expect(g.calls.some((c) => c[0] === 'cancel')).toBe(true);
      expect(g.calls.at(-1)?.[0]).toBe('lin');
      expect(g.calls.at(-1)?.[1]).toBe(0);
    }
  });

  it('plays nothing when muted, and remembers the choice', () => {
    const s = createPlayer();
    s.unlock();
    s.setEnabled(false);
    s.play('ok');
    expect(FakeContext.all[0]?.oscs).toHaveLength(0);
    expect(localStorage.getItem('passbook-scan-sound')).toBe('0');
    expect(createPlayer().enabled()).toBe(false);
  });

  it('turning sound on previews ok once', () => {
    const s = createPlayer();
    s.setEnabled(false);
    s.setEnabled(true);
    expect(FakeContext.all[0]?.oscs).toHaveLength(1);
    s.setEnabled(true);
    expect(FakeContext.all[0]?.oscs).toHaveLength(1);
  });

  it('a throwing store means on', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    const s = createPlayer();
    expect(s.enabled()).toBe(true);
    expect(() => s.setEnabled(false)).not.toThrow();
    s.unlock();
    s.setEnabled(true);
    s.play('ok');
    expect(FakeContext.all[0]?.oscs.length).toBeGreaterThan(0);
  });

  it('makes no context without audio support', () => {
    vi.stubGlobal('AudioContext', undefined);
    const s = createPlayer();
    expect(() => {
      s.unlock();
      s.play('ok');
      s.cut();
    }).not.toThrow();
  });

  it('fits 1.75 kB of source', () => {
    const dir = join(process.cwd(), 'src/web/scan/sound');
    const source = ['tones.ts', 'player.ts', 'audio-unlock.ts']
      .map((f) => readFileSync(join(dir, f), 'utf8'))
      .join('\n');
    expect(gzipSync(source, { level: 9 }).length).toBeLessThanOrEqual(1.75 * 1024);
  });
});
