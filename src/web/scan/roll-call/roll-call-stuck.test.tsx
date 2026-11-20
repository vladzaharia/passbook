import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../lib/test-utils.tsx';
import { ApiError } from '../../lib/errors.ts';
import { call, fakeRollCall, person, T0 } from './roll-call-fake.test-support.ts';
import { RollCallPanel } from './roll-call-panel.tsx';
import { stuck } from './roll-call-sync.ts';
import { useRollCall } from './use-roll-call.ts';

const connect = vi.fn(() => ({ close: vi.fn() }));

function rig() {
  const port = fakeRollCall(call([person(0), person(1), person(2)]));
  const h = renderHook(() =>
    useRollCall({ port, enabled: true, online: true, by: '', connect: connect as never }),
  );
  return { port, h };
}

/** Lets the retry delay pass and runs the poll that flushes. */
const tick = async (h: ReturnType<typeof rig>['h']) => {
  await act(async () => void (await vi.advanceTimersByTimeAsync(70_000)));
  await act(async () => void (await h.result.current.reload()));
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => vi.useRealTimers());

describe('stuck', () => {
  it('counts the failing batch by its first tap, whatever is queued behind it', () => {
    const marks = [0, 1, 2, 3, 4].map((n) => ({
      callId: 'c',
      passId: person(n).passId,
      status: 'present' as const,
      at: n === 0 ? 1 : 10 + n,
    }));
    const repeats = { current: { key: '', n: 0 } };
    const error = new ApiError({ status: 400, code: 'X' });
    const answers = [1, 2, 3, 4, 5].map((n) => stuck(repeats, 400, error, marks.slice(0, n)));
    expect(answers).toEqual([false, false, false, false, true]);
  });
});

describe('a batch that keeps failing', () => {
  it('keeps counting while the desk keeps tapping, and saves the good taps', async () => {
    const { port, h } = rig();
    await waitFor(() => expect(h.result.current.call).not.toBeNull());
    port.failFor.set(
      person(0).passId,
      new ApiError({ status: 400, code: 'SCAN_MARK_OUT_INVALID' }),
    );
    act(() => h.result.current.mark(person(0).passId, 'out'));
    for (let i = 0; i < 6 && h.result.current.unsaved.length === 0; i++) {
      // A new tap behind the bad one must not reset the count.
      if (i === 0) act(() => h.result.current.mark(person(1).passId, 'present'));
      await tick(h);
    }
    await waitFor(() => expect(h.result.current.unsaved).toHaveLength(1));
    expect(h.result.current.unsaved[0]).toMatchObject({
      passId: person(0).passId,
      reason: 'SCAN_MARK_OUT_INVALID',
    });
    await waitFor(() => expect(h.result.current.pending).toBe(0));
    expect(h.result.current.call?.counts.present).toBe(1);
  });

  it('sets aside a tap that keeps getting a 5xx alone while other taps get through', async () => {
    const { port, h } = rig();
    await waitFor(() => expect(h.result.current.call).not.toBeNull());
    port.failFor.set(person(0).passId, new ApiError({ status: 500, code: 'INTERNAL' }));
    act(() => h.result.current.mark(person(0).passId, 'out'));
    act(() => h.result.current.mark(person(1).passId, 'present'));
    // Round one saves the good tap; the bad one is alone after that, so the sync stalls with it queued.
    for (let i = 0; i < 40 && !h.result.current.stalled; i++) await tick(h);
    await waitFor(() => expect(h.result.current.stalled).toBe(true));
    expect(h.result.current.unsaved).toEqual([]);
    // Round two: another tap gets through, so the failing one is the problem and is set aside.
    act(() => h.result.current.mark(person(2).passId, 'present'));
    act(() => h.result.current.retryStalled());
    for (let i = 0; i < 40 && h.result.current.unsaved.length === 0; i++) await tick(h);
    await waitFor(() => expect(h.result.current.unsaved).toHaveLength(1));
    expect(h.result.current.unsaved[0]).toMatchObject({
      passId: person(0).passId,
      reason: 'INTERNAL',
    });
    await waitFor(() => expect(h.result.current.pending).toBe(0));
    expect(h.result.current.call?.counts.present).toBe(2);
    expect(h.result.current.stalled).toBe(false);
  });

  it('stalls visibly when the server is down for every tap, keeps them, and retries on request', async () => {
    const { port, h } = rig();
    await waitFor(() => expect(h.result.current.call).not.toBeNull());
    port.fail = new ApiError({ status: 503, code: 'UNAVAILABLE' });
    act(() => h.result.current.mark(person(0).passId, 'present'));
    for (let i = 0; i < 8 && !h.result.current.stalled; i++) await tick(h);
    await waitFor(() => expect(h.result.current.stalled).toBe(true));
    expect(h.result.current.pending).toBe(1);
    expect(h.result.current.unsaved).toEqual([]);
    // No more tries on its own.
    const sent = port.calls.marks.length;
    await tick(h);
    expect(port.calls.marks).toHaveLength(sent);
    render(
      <RollCallPanel
        roll={h.result.current}
        online
        now={T0 + 60_000}
        onEnd={vi.fn()}
        onPrint={vi.fn()}
      />,
    );
    expect(screen.getByText('Not saving. 1 to sync')).toBeInTheDocument();
    port.fail = null;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(h.result.current.pending).toBe(0));
    expect(h.result.current.stalled).toBe(false);
    expect(h.result.current.call?.counts.present).toBe(1);
  });

  it('retries a tap that got a 5xx alone, and saves it once the server recovers', async () => {
    const { port, h } = rig();
    await waitFor(() => expect(h.result.current.call).not.toBeNull());
    port.failFor.set(person(0).passId, new ApiError({ status: 500, code: 'INTERNAL' }));
    act(() => h.result.current.mark(person(0).passId, 'out'));
    act(() => h.result.current.mark(person(1).passId, 'present'));
    // One round of isolation: the good tap is saved, the failing one stays queued, not set aside.
    for (let i = 0; i < 40 && h.result.current.pending > 1; i++) await tick(h);
    await waitFor(() => expect(h.result.current.pending).toBe(1));
    expect(h.result.current.unsaved).toEqual([]);
    port.failFor.clear();
    for (let i = 0; i < 10 && h.result.current.pending > 0; i++) await tick(h);
    await waitFor(() => expect(h.result.current.pending).toBe(0));
    expect(h.result.current.unsaved).toEqual([]);
    expect(h.result.current.call?.counts.out).toBe(1);
  });

  it('stalls when a 4xx batch gets a 5xx for every tap alone', async () => {
    const { port, h } = rig();
    await waitFor(() => expect(h.result.current.call).not.toBeNull());
    const send = port.marks;
    port.marks = async (_id, marks) => {
      if (marks.length > 1) throw new ApiError({ status: 400, code: 'BAD' });
      throw new ApiError({ status: 503, code: 'UNAVAILABLE' });
    };
    act(() => h.result.current.mark(person(0).passId, 'present'));
    act(() => h.result.current.mark(person(1).passId, 'present'));
    for (let i = 0; i < 12 && !h.result.current.stalled; i++) await tick(h);
    await waitFor(() => expect(h.result.current.stalled).toBe(true));
    expect(h.result.current.pending).toBe(2);
    port.marks = send;
  });

  it('clears the stall when the call ends, so the chip never reads 0 to sync', async () => {
    const { port, h } = rig();
    await waitFor(() => expect(h.result.current.call).not.toBeNull());
    port.fail = new ApiError({ status: 503, code: 'UNAVAILABLE' });
    act(() => h.result.current.mark(person(0).passId, 'present'));
    for (let i = 0; i < 8 && !h.result.current.stalled; i++) await tick(h);
    await waitFor(() => expect(h.result.current.stalled).toBe(true));
    port.server = null;
    await act(async () => void (await h.result.current.reload()));
    await waitFor(() => expect(h.result.current.call).toBeNull());
    expect(h.result.current.pending).toBe(0);
    expect(h.result.current.stalled).toBe(false);
  });
});
