import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useHub } from './use-hub.ts';

class FakeSocket {
  static all: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 0;
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeSocket.all.push(this);
  }
  send() {}
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}
const say = (s: FakeSocket, body: object) => s.onmessage?.({ data: JSON.stringify(body) });

beforeEach(() => {
  FakeSocket.all = [];
  vi.stubGlobal('WebSocket', FakeSocket);
});
afterEach(() => vi.unstubAllGlobals());

describe('the operator hub', () => {
  it('opens no socket when it is off', () => {
    renderHook(() => useHub(false));
    expect(FakeSocket.all).toHaveLength(0);
  });

  it('is up while the socket is open, counts pulses, and is down once it closes', () => {
    const { result } = renderHook(() => useHub(true));
    const s = FakeSocket.all[0];
    if (!s) throw new Error('no socket');
    expect(s.url).toContain('/api/v1/scan/live?as=device');
    expect(result.current.up).toBe(false);
    act(() => s.onopen?.());
    expect(result.current.up).toBe(true);
    act(() => say(s, { pulse: 1 }));
    act(() => say(s, { pulse: 1 }));
    expect(result.current.pulses).toBe(2);
    act(() => s.close());
    expect(result.current.up).toBe(false);
  });

  it('shares its one socket with a listener, which hears the opens and the other nudges but no pulse is lost to it', () => {
    const { result } = renderHook(() => useHub(true));
    const s = FakeSocket.all[0];
    if (!s) throw new Error('no socket');
    const onOpen = vi.fn();
    const onNudge = vi.fn();
    act(() => {
      s.onopen?.();
    });
    const link = result.current.connect({ url: 'x', onOpen, onNudge });
    // Already open: the listener is told at once, as a fresh socket would.
    expect(onOpen).toHaveBeenCalledTimes(1);
    act(() => say(s, { rollCall: { id: 'r1', rev: 2, ended: false } }));
    expect(onNudge).toHaveBeenCalledWith({ kind: 'rollCall', id: 'r1', rev: 2, ended: false });
    link.close();
    act(() => say(s, { rollCall: { id: 'r1', rev: 3, ended: false } }));
    expect(onNudge).toHaveBeenCalledTimes(1);
    expect(FakeSocket.all).toHaveLength(1);
  });

  it('closes its socket when it unmounts', () => {
    const { unmount } = renderHook(() => useHub(true));
    const s = FakeSocket.all[0];
    unmount();
    expect(s?.readyState).toBe(3);
  });
});
