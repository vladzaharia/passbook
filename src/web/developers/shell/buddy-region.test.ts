import { afterEach, describe, expect, it, vi } from 'vitest';
import { joinRegion, MAX_IN_VIEW, PLAY_LOCK_MS, resetBuddyRegions } from './buddy-region.ts';

afterEach(() => {
  resetBuddyRegions();
  vi.useRealTimers();
});

describe('buddy regions', () => {
  it('allows one buddy per region and frees it on release', () => {
    const a = joinRegion('main');
    const b = joinRegion('main');
    const c = joinRegion('stage');
    expect([a.allowed, b.allowed, c.allowed]).toEqual([true, false, true]);
    expect(b.inView(true)).toBe(false);
    expect(b.play()).toBeNull();
    b.release();
    expect(joinRegion('main').allowed).toBe(false);
    a.release();
    expect(joinRegion('main').allowed).toBe(true);
  });

  it('keeps at most two in view, and a hidden one makes room', () => {
    const slots = (['band', 'main', 'stage'] as const).map(joinRegion);
    expect(MAX_IN_VIEW).toBe(2);
    expect(slots.map((s) => s.inView(true))).toEqual([true, true, false]);
    expect(slots[0]?.inView(true)).toBe(true);
    slots[0]?.inView(false);
    expect(slots[2]?.inView(true)).toBe(true);
    slots[1]?.release();
    slots[0]?.inView(true);
    expect(slots[0]?.inView(true)).toBe(true);
  });

  it('plays one scene at a time', () => {
    const a = joinRegion('main');
    const b = joinRegion('stage');
    const done = a.play();
    expect(done).toBeTypeOf('function');
    expect(b.play()).toBeNull();
    done?.();
    const next = b.play();
    expect(next).toBeTypeOf('function');
    expect(a.play()).toBeNull();
  });

  it('frees the turn after the longest scene, and when its buddy leaves', () => {
    vi.useFakeTimers();
    const a = joinRegion('main');
    const b = joinRegion('stage');
    a.play();
    vi.advanceTimersByTime(PLAY_LOCK_MS - 1);
    expect(b.play()).toBeNull();
    vi.advanceTimersByTime(2);
    expect(b.play()).toBeTypeOf('function');
    b.release();
    expect(a.play()).toBeTypeOf('function');
    a.release();
    expect(joinRegion('band').play()).toBeTypeOf('function');
  });
});
