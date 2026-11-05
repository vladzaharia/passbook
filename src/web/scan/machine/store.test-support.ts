/** A fake clock and fake ports for store tests. */
import { vi } from 'vitest';
import { ApiError } from '../../lib/errors.ts';
import { FIXTURE_NOW, fixtureOutcome } from './fixture-data.test-support.ts';
import type { ActBody, FailInfo, ResolveBody, ScanDeps, UnsureRow } from './ports.ts';

export interface FakeClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** Moves time forward, firing timers in order. */
  advance(ms: number): void;
}

export function fakeClock(start = FIXTURE_NOW): FakeClock {
  let now = start;
  let n = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = ++n;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].fn();
      }
      now = end;
    },
  };
}

export const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export function memoryUnsure() {
  const rows = new Map<string, UnsureRow>();
  return {
    rows,
    put: async (row: UnsureRow) => void rows.set(row.entry.key, row),
    remove: async (key: string) => void rows.delete(key),
    all: async () => [...rows.values()],
    clear: async () => rows.clear(),
  };
}

export function fakeDeps(clock: FakeClock = fakeClock()) {
  let n = 0;
  const unsure = memoryUnsure();
  const calls: string[] = [];
  const api = {
    resolve: vi.fn(async (_body: ResolveBody, _o: { signal: AbortSignal }) =>
      fixtureOutcome('ready'),
    ),
    act: vi.fn(async (_body: ActBody, _o: { signal: AbortSignal }) => fixtureOutcome('ok')),
    undo: vi.fn(
      async (_id: string, _body: { idempotencyKey: string }, _o: { signal: AbortSignal }) =>
        fixtureOutcome('ok'),
    ),
  };
  const deps = {
    api,
    toFail: (error: unknown): FailInfo =>
      error instanceof ApiError && error.status === 0 ? { error: 'network' } : { error: 'server' },
    camera: {
      start: () => void calls.push('camera.start'),
      pause: () => void calls.push('camera.pause'),
      resume: () => void calls.push('camera.resume'),
      stop: () => void calls.push('camera.stop'),
      slow: () => void calls.push('camera.slow'),
    },
    wake: {
      request: () => void calls.push('wake.request'),
      release: () => void calls.push('wake.release'),
    },
    audio: { unlock: () => void calls.push('audio.unlock') },
    sound: { play: vi.fn((tone: string) => void calls.push(`sound.${tone}`)) },
    announce: vi.fn(),
    focus: vi.fn(),
    chip: vi.fn(),
    celebrate: vi.fn(),
    unsure,
    scannerId: () => 'scanner-1',
    base: () => ({ dayStart: FIXTURE_NOW - 1000 }),
    wipe: vi.fn(),
    clock,
    ids: { id: () => `01900000-0000-7000-8000-${(++n + 0x800).toString(16).padStart(12, '0')}` },
  } satisfies ScanDeps;
  return { deps, calls, unsure, api };
}
