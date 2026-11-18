import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../lib/test-utils.tsx';
import { ApiError } from '../../lib/errors.ts';
import { toFail } from '../api/to-fail.ts';
import { SCAN_TIMING } from '../timing.ts';
import { fakeInsideApi, rows } from './inside-fake.test-support.ts';
import { useInside } from './use-inside.ts';

const notify = () => ({ undo: vi.fn(), error: vi.fn() });

function setup(over: Partial<Parameters<typeof useInside>[0]> = {}, count = 4) {
  const api = fakeInsideApi(rows(count));
  const n = notify();
  const view = renderHook(
    (props: { active: boolean; online: boolean }) =>
      useInside({ api, notify: n, onFail: vi.fn(), ...props, ...over }),
    { initialProps: { active: true, online: true } },
  );
  return { api, n, ...view };
}

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => vi.useRealTimers());

describe('useInside', () => {
  it('loads the list longest first when it opens, and not before', async () => {
    const closed = setup();
    closed.rerender({ active: false, online: true });
    const { api, result } = setup();
    await waitFor(() => expect(result.current.state.rows).toHaveLength(4));
    expect(api.calls.inside[0]).toMatchObject({ limit: 50 });
    const since = result.current.state.rows.map((r) => r.since);
    expect([...since].sort((a, b) => a - b)).toEqual(since);
  });
  it('waits for the typing to stop, then asks with q', async () => {
    const { api, result } = setup();
    await waitFor(() => expect(result.current.state.rows).toHaveLength(4));
    act(() => result.current.setQuery('le'));
    act(() => result.current.setQuery('leo'));
    expect(api.calls.inside).toHaveLength(1);
    await act(() => vi.advanceTimersByTimeAsync(SCAN_TIMING.SEARCH_DEBOUNCE));
    await waitFor(() => expect(api.calls.inside).toHaveLength(2));
    expect(api.calls.inside[1]).toMatchObject({ q: 'leo' });
    expect(result.current.state.rows.every((r) => r.holder?.toLowerCase().includes('leo'))).toBe(
      true,
    );
  });
  it('filters by place without waiting', async () => {
    const { api, result } = setup();
    await waitFor(() => expect(result.current.state.rows).toHaveLength(4));
    act(() => result.current.setPlace('zone:gym'));
    await waitFor(() => expect(api.calls.inside.at(-1)).toMatchObject({ place: 'zone:gym' }));
  });
  it('pages with the cursor', async () => {
    const { api, result } = setup({}, 60);
    await waitFor(() => expect(result.current.state.rows).toHaveLength(50));
    await act(() => result.current.more());
    expect(api.calls.inside.at(-1)).toMatchObject({ cursor: '50' });
    expect(result.current.state.rows).toHaveLength(60);
    expect(result.current.state.next).toBeNull();
  });
  it('refreshes every 15 s while open', async () => {
    const { api } = setup();
    await waitFor(() => expect(api.calls.inside).toHaveLength(1));
    await act(() => vi.advanceTimersByTimeAsync(SCAN_TIMING.COUNTS_POLL));
    expect(api.calls.inside).toHaveLength(2);
  });
  it('offline it asks for nothing and keeps the last list', async () => {
    const { api, result, rerender } = setup();
    await waitFor(() => expect(result.current.state.rows).toHaveLength(4));
    rerender({ active: true, online: false });
    await act(() => vi.advanceTimersByTimeAsync(SCAN_TIMING.COUNTS_POLL * 2));
    expect(api.calls.inside).toHaveLength(1);
    expect(result.current.state.rows).toHaveLength(4);
  });
  it('marks out, takes the row away and offers Undo', async () => {
    const { api, n, result } = setup();
    await waitFor(() => expect(result.current.state.rows).toHaveLength(4));
    const row = result.current.state.rows[1];
    if (!row) throw new Error('row');
    await act(() => result.current.markOut(row));
    expect(api.calls.markOut[0]).toMatchObject({ passId: row.passId, place: row.place });
    expect(api.calls.markOut[0]?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.current.state.rows.some((r) => r.passId === row.passId)).toBe(false);
    expect(n.undo).toHaveBeenCalledWith(`${row.holder} marked as out`, expect.any(Function));
    // Undo takes it back and reloads the list.
    api.rows = rows(4);
    await act(async () => void (await n.undo.mock.calls[0]?.[1]()));
    expect(api.calls.undo).toEqual(['scan-1']);
    await waitFor(() => expect(result.current.state.rows).toHaveLength(4));
  });
  it('a failed mark-out puts the row back and says so', async () => {
    const { api, n, result } = setup();
    await waitFor(() => expect(result.current.state.rows).toHaveLength(4));
    const row = result.current.state.rows[0];
    if (!row) throw new Error('row');
    api.fail.markOut = new ApiError({ status: 500, code: 'server_error' });
    await act(() => result.current.markOut(row));
    expect(result.current.state.rows.map((r) => r.passId)).toContain(row.passId);
    expect(n.error).toHaveBeenCalledWith(expect.anything(), 'Could not mark as out');
    expect(n.undo).not.toHaveBeenCalled();
  });
  it('a signed-out scanner hands the failure to the machine', async () => {
    const onFail = vi.fn();
    const api = fakeInsideApi(rows(2));
    api.fail.inside = new ApiError({ status: 403, code: 'STAFF_REQUIRED' });
    const { result } = renderHook(() =>
      useInside({ api, active: true, online: true, notify: notify(), onFail, failOf: toFail }),
    );
    await waitFor(() => expect(result.current.state.error).toBe(true));
    expect(onFail).toHaveBeenCalledWith({ error: 'staff_required' });
  });
  it('a failure with no list shows the error, and retry loads', async () => {
    const api = fakeInsideApi(rows(2));
    api.fail.inside = new ApiError({ status: 500, code: 'server_error' });
    const { result } = renderHook(() =>
      useInside({ api, active: true, online: true, notify: notify() }),
    );
    await waitFor(() => expect(result.current.state.error).toBe(true));
    api.fail.inside = null;
    await act(() => result.current.retry());
    expect(result.current.state).toMatchObject({ error: false });
    expect(result.current.state.rows).toHaveLength(2);
  });
});
