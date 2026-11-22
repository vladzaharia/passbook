import { afterEach, describe, expect, it, vi } from 'vitest';
import { homeDone, homeFresh, homeNone } from '../workbench/home-fixtures.ts';
import { loadClock, onClock, publishClock, runTime } from './run-clock.ts';

afterEach(() => publishClock(null));

describe('run clock', () => {
  it('counts from the server start, with the device offset, until the track is done', () => {
    if (!homeFresh.progress) throw new Error('fixture');
    const seen: unknown[] = [];
    const stop = onClock((c) => seen.push(c));
    vi.spyOn(Date, 'now').mockReturnValue(10_000);
    publishClock({ ...homeFresh, now: 70_000 });
    const clock = seen.at(-1) as Parameters<typeof runTime>[0];
    expect(clock.skew).toBe(60_000);
    expect(runTime({ ...clock, startedAt: 10_000 }, 10_000)).toBe('1:00');
    expect(runTime({ ...clock, doneAt: 5 })).toBeNull();
    stop();
    vi.restoreAllMocks();
  });

  it('has no clock for no sandbox or a done one that closed', () => {
    const seen: unknown[] = [];
    onClock((c) => seen.push(c));
    publishClock(homeNone);
    expect(seen.at(-1)).toBeNull();
    publishClock({ ...homeDone, state: 'closed' });
    expect(seen.at(-1)).toBeNull();
  });

  it('a page that already read the home is not read again', async () => {
    publishClock(homeFresh);
    const read = vi.fn().mockResolvedValue(homeFresh);
    await Promise.all([loadClock(read), loadClock(read)]);
    expect(read).not.toHaveBeenCalled();
  });
});
