import { describe, expect, it, vi } from 'vitest';
import {
  BACKOFF_MS,
  connectDeviceSocket,
  deviceSocketUrl,
  PING_MS,
  type SocketCtor,
} from './device-socket.ts';

function harness() {
  const sockets: FakeSocket[] = [];
  class FakeSocket {
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: unknown }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    readyState = 1;
    sent: string[] = [];
    url: string;
    constructor(url: string) {
      this.url = url;
      sockets.push(this);
    }
    send(d: string) {
      this.sent.push(d);
    }
    close() {
      this.readyState = 3;
      this.onclose?.();
    }
  }
  const timers: { fn: () => void; ms: number; id: number }[] = [];
  let n = 0;
  const deps = {
    Socket: FakeSocket as unknown as SocketCtor,
    setTimeout: (fn: () => void, ms: number) => {
      timers.push({ fn, ms, id: ++n });
      return n;
    },
    clearTimeout: (h: unknown) => {
      const i = timers.findIndex((t) => t.id === h);
      if (i >= 0) timers.splice(i, 1);
    },
  };
  return { sockets, timers, deps };
}

describe('device socket', () => {
  it('builds the device url from the page location', () => {
    expect(deviceSocketUrl({ protocol: 'https:', host: 'x.test' })).toBe(
      'wss://x.test/api/v1/scan/live?as=device',
    );
    expect(deviceSocketUrl({ protocol: 'http:', host: 'x.test' })).toBe(
      'ws://x.test/api/v1/scan/live?as=device',
    );
  });

  it('turns an enroll message into a nudge, a cancel into a cancelled nudge, and drops anything else', () => {
    const h = harness();
    const onNudge = vi.fn();
    const onOpen = vi.fn();
    connectDeviceSocket({ url: 'u', onNudge, onOpen, ...h.deps });
    const s = h.sockets[0];
    s?.onopen?.();
    expect(onOpen).toHaveBeenCalledTimes(1);
    s?.onmessage?.({ data: JSON.stringify({ enroll: { id: 'e1', expiresAt: 5 } }) });
    s?.onmessage?.({ data: JSON.stringify({ enroll: { id: 'e1', cancelled: true } }) });
    s?.onmessage?.({ data: JSON.stringify({ control: 'reset' }) });
    s?.onmessage?.({
      data: JSON.stringify({
        resolved: {
          of: '01900000-0000-7000-8000-000000000009',
          outcome: 'ok',
          by: { staff: 'Sam K.', device: 'Desk 1' },
        },
      }),
    });
    s?.onmessage?.({ data: 'not json' });
    s?.onmessage?.({ data: new ArrayBuffer(2) });
    expect(onNudge.mock.calls).toEqual([
      [{ kind: 'enroll', id: 'e1' }],
      [{ kind: 'cancelled', id: 'e1' }],
      [{ kind: 'reset' }],
      [
        {
          kind: 'resolved',
          resolved: {
            of: '01900000-0000-7000-8000-000000000009',
            outcome: 'ok',
            by: { staff: 'Sam K.', device: 'Desk 1' },
          },
        },
      ],
    ]);
  });

  it('reconnects with a growing back-off, resets after an open, and reads pending on each open', () => {
    const h = harness();
    const onOpen = vi.fn();
    connectDeviceSocket({ url: 'u', onNudge: vi.fn(), onOpen, ...h.deps });
    const closeAndWait = () => {
      h.sockets.at(-1)?.close();
      const t = h.timers.filter((x) => x.ms !== PING_MS).at(-1);
      expect(t).toBeDefined();
      return t;
    };
    expect(closeAndWait()?.ms).toBe(BACKOFF_MS[0]);
    h.timers.pop()?.fn();
    expect(closeAndWait()?.ms).toBe(BACKOFF_MS[1]);
    h.timers.pop()?.fn();
    h.sockets.at(-1)?.onopen?.();
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(closeAndWait()?.ms).toBe(BACKOFF_MS[0]);
  });

  it('pings while open and stops for good on close', () => {
    const h = harness();
    const c = connectDeviceSocket({ url: 'u', onNudge: vi.fn(), onOpen: vi.fn(), ...h.deps });
    h.sockets[0]?.onopen?.();
    h.timers.find((t) => t.ms === PING_MS)?.fn();
    expect(h.sockets[0]?.sent).toEqual(['ping']);
    c.close();
    expect(h.timers.filter((t) => t.ms !== PING_MS)).toEqual([]);
    expect(h.sockets).toHaveLength(1);
  });

  it('turns a pulse into an activity nudge, and reports each close until closed on purpose', () => {
    const h = harness();
    const onNudge = vi.fn();
    const onClose = vi.fn();
    const c = connectDeviceSocket({ url: 'u', onNudge, onOpen: vi.fn(), onClose, ...h.deps });
    const s = h.sockets[0];
    s?.onopen?.();
    s?.onmessage?.({ data: JSON.stringify({ pulse: 1 }) });
    s?.onmessage?.({ data: JSON.stringify({ pulse: 2 }) });
    expect(onNudge.mock.calls).toEqual([[{ kind: 'activity' }]]);
    s?.close();
    expect(onClose).toHaveBeenCalledTimes(1);
    c.close();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
