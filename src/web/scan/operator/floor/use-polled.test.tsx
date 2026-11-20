import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePolled } from './use-polled.ts';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('usePolled', () => {
  it('reads again once, shortly after a burst of kicks', async () => {
    const read = vi.fn(async () => 1);
    const { rerender } = renderHook(
      ({ kick }) => usePolled(read, { active: true, online: true, every: 60_000, kick }),
      { initialProps: { kick: 0 } },
    );
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(read).toHaveBeenCalledTimes(1);
    rerender({ kick: 1 });
    rerender({ kick: 2 });
    rerender({ kick: 3 });
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('never reads on a kick of 0, and carries on by its own timer', async () => {
    const read = vi.fn(async () => 1);
    renderHook(() => usePolled(read, { active: true, online: true, every: 20_000, kick: 0 }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(read).toHaveBeenCalledTimes(2);
  });
});
