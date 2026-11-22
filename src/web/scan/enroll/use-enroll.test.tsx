import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const s = vi.hoisted(() => ({
  opts: null as null | { onOpen: () => void; onNudge: (n: unknown) => void },
  close: vi.fn(),
}));
vi.mock('./device-socket.ts', () => ({
  deviceSocketUrl: () => 'ws://x',
  connectDeviceSocket: (o: { onOpen: () => void; onNudge: (n: unknown) => void }) => {
    s.opts = o;
    return { close: s.close };
  },
}));

import { useEnrollment } from './use-enroll.ts';

const request = { id: 'r1' };
beforeEach(() => {
  vi.clearAllMocks();
  s.opts = null;
});

const setup = (over: { pending?: () => Promise<unknown>; showing?: string | null } = {}) => {
  const api = { pending: vi.fn(over.pending ?? (async () => request)) };
  const dispatch = vi.fn();
  const onResolved = vi.fn();
  const hook = renderHook(
    (p: { enabled: boolean }) =>
      useEnrollment({
        api: api as never,
        enabled: p.enabled,
        showing: over.showing ?? null,
        dispatch,
        onResolved,
      }),
    { initialProps: { enabled: true } },
  );
  return { api, dispatch, onResolved, ...hook };
};

describe('useEnrollment', () => {
  it('does nothing while disabled', () => {
    setup();
    const off = setup();
    off.rerender({ enabled: false });
    expect(off.api.pending).not.toHaveBeenCalled();
  });

  it('reads the pending request when the socket opens, and shows it', async () => {
    const { dispatch } = setup();
    s.opts?.onOpen();
    await waitFor(() => expect(dispatch).toHaveBeenCalledWith({ type: 'enroll.arrive', request }));
  });

  it('ends the request on screen when a read finds none', async () => {
    const { dispatch } = setup({ pending: async () => null, showing: 'r9' });
    s.opts?.onOpen();
    await waitFor(() =>
      expect(dispatch).toHaveBeenCalledWith({ type: 'enroll.cancelled', id: 'r9' }),
    );
  });

  it('follows nudges: cancelled, resolved, ignored kinds, and a read for the rest', async () => {
    const { dispatch, onResolved, api } = setup();
    s.opts?.onNudge({ kind: 'cancelled', id: 'r2' });
    expect(dispatch).toHaveBeenCalledWith({ type: 'enroll.cancelled', id: 'r2' });
    s.opts?.onNudge({ kind: 'resolved', resolved: { id: 'r3' } });
    expect(onResolved).toHaveBeenCalledWith({ id: 'r3' });
    s.opts?.onNudge({ kind: 'rollCall' });
    s.opts?.onNudge({ kind: 'activity' });
    expect(api.pending).not.toHaveBeenCalled();
    s.opts?.onNudge({ kind: 'enroll' });
    await waitFor(() => expect(api.pending).toHaveBeenCalledTimes(1));
  });

  it('reads again when the device comes online or the tab shows, and ignores a failed read', async () => {
    const { api } = setup({
      pending: async () => {
        throw new Error('offline');
      },
    });
    window.dispatchEvent(new Event('online'));
    document.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() => expect(api.pending).toHaveBeenCalledTimes(2));
  });

  it('closes the socket and stops listening on unmount', () => {
    const { api, unmount } = setup();
    unmount();
    expect(s.close).toHaveBeenCalled();
    window.dispatchEvent(new Event('online'));
    expect(api.pending).not.toHaveBeenCalled();
  });
});
