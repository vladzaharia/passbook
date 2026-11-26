import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../console/session.ts';

const m = vi.hoisted(() => ({
  send: vi.fn(),
  template: vi.fn(),
  refresh: vi.fn(async () => null),
  home: { current: null as unknown },
  beacon: vi.fn(),
  updateSession: vi.fn(),
}));

vi.mock('../playground/live.ts', () => ({
  PORTAL_READ: {},
  LiveError: class LiveError extends Error {
    status: number;
    code: string | undefined;
    constructor(status: number, code: string | undefined, message: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
  LiveClient: class {
    send = m.send;
    template = m.template;
  },
}));
vi.mock('../playground/templates.ts', () => ({
  fromDetail: (t: { sample: Record<string, unknown> }) => ({ sample: t.sample }),
}));
vi.mock('./use-home.ts', () => ({
  useHome: () => ({ home: m.home.current, skew: 0, refresh: m.refresh }),
}));
vi.mock('./beacon.ts', () => ({ beacon: m.beacon }));
vi.mock('./viewed.ts', () => ({ markViewed: () => 111 }));
vi.mock('../console/session.ts', () => ({ updateSession: m.updateSession }));

import { LiveError } from '../playground/live.ts';
import { useQuickstart } from './use-quickstart.ts';

const sandbox = { id: 's', orgId: 'org-1', orgSlug: 'o', templateId: 't1' };
const ready: Session = { kind: 'ready', csrf: 'c', sandbox, siteKey: 'k' };
const body = (version: number) => ({
  id: 'p1',
  version,
  downloadUrl: '/preview',
  passJson: {},
  assetBaseUrl: '/a',
  assetNames: [],
  personalization: { attendee: 'x' },
});
const ok = (b: unknown, extra = {}) => ({
  ok: true,
  status: 201,
  ms: 12,
  requestId: 'r',
  replayed: false,
  etag: '"1"',
  body: b,
  ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  m.home.current = null;
  m.template.mockResolvedValue({ sample: { name: 'n' } });
});

describe('useQuickstart', () => {
  it('reads the template, tells the funnel once, and makes then changes a pass', async () => {
    m.send.mockResolvedValueOnce(ok(body(1))).mockResolvedValueOnce(ok(body(2), { status: 200 }));
    const { result } = renderHook(() => useQuickstart(ready));
    await waitFor(() => expect(result.current.input).not.toBeNull());
    expect(result.current.viewedAt).toBe(111);
    expect(m.beacon).toHaveBeenCalledWith('c', 'view');
    await act(() => result.current.create());
    expect(result.current.run).toMatchObject({ state: 'ok', status: 201 });
    expect(result.current.pass?.version).toBe(1);
    expect(m.send.mock.calls[0]?.[3]).toHaveProperty('Idempotency-Key');
    expect(m.beacon).toHaveBeenCalledWith('c', 'run');
    await act(() => result.current.update('VIP'));
    expect(m.send.mock.calls[1]).toEqual([
      'PATCH',
      '/passes/p1',
      { input: { admission: 'VIP' }, notify: true },
      { 'If-Match': '"1"' },
    ]);
    expect(result.current.change).toMatchObject({ state: 'ok', via: 'here', etag: '"1"' });
    expect(result.current.pass?.version).toBe(2);
    expect(m.beacon).toHaveBeenCalledWith('c', 'change');
  });

  it('records a refused create with its code, and a new key for the retry', async () => {
    m.send
      .mockResolvedValueOnce({
        ok: false,
        status: 422,
        ms: 1,
        requestId: 'r9',
        problem: { code: 'BAD', detail: 'no' },
      })
      .mockRejectedValueOnce(new LiveError(500, 'BOOM', 'down'))
      .mockRejectedValueOnce(new Error('offline'));
    const { result } = renderHook(() => useQuickstart(ready));
    await waitFor(() => expect(result.current.input).not.toBeNull());
    await act(() => result.current.create());
    expect(result.current.run).toMatchObject({
      state: 'fail',
      problem: { status: 422, code: 'BAD', detail: 'no' },
      requestId: 'r9',
    });
    expect(m.beacon).toHaveBeenCalledWith('c', 'fail', 'BAD');
    const first = m.send.mock.calls[0]?.[3]['Idempotency-Key'];
    await act(() => result.current.create());
    expect(result.current.run).toMatchObject({ state: 'fail', problem: { code: 'BOOM' } });
    expect(m.send.mock.calls[1]?.[3]['Idempotency-Key']).not.toBe(first);
    await act(() => result.current.create());
    expect(result.current.run).toMatchObject({ state: 'fail', problem: { status: 0 } });
    expect(m.beacon).toHaveBeenCalledWith('c', 'fail', 'NETWORK');
  });

  it('records a failed change, and does nothing without a pass', async () => {
    const { result } = renderHook(() => useQuickstart(ready));
    await act(() => result.current.update('VIP'));
    expect(m.send).not.toHaveBeenCalled();
    m.send
      .mockResolvedValueOnce(ok(body(1)))
      .mockResolvedValueOnce({ ok: false, status: 412, ms: 1, requestId: null, problem: undefined })
      .mockRejectedValueOnce(new Error('offline'));
    await waitFor(() => expect(result.current.input).not.toBeNull());
    await act(() => result.current.create());
    await act(() => result.current.update('VIP'));
    expect(result.current.change).toMatchObject({ state: 'fail', problem: { status: 412 } });
    await act(() => result.current.update('VIP'));
    expect(result.current.change).toMatchObject({ state: 'fail', problem: { status: 0 } });
    expect(m.beacon).toHaveBeenCalledWith('c', 'fail', 'NETWORK');
  });

  it('shows a call heard from a terminal and reports the first render once', async () => {
    const { result } = renderHook(() => useQuickstart(ready));
    act(() =>
      result.current.heardPass({
        status: 201,
        durationMs: 30,
        requestId: 'r2',
        at: 5,
        client: 'curl/8',
      } as never),
    );
    expect(result.current.run).toMatchObject({ state: 'ok', via: 'terminal', client: 'curl/8' });
    expect(m.refresh).toHaveBeenCalled();
    act(() => result.current.rendered(40));
    act(() => result.current.rendered(50));
    expect(result.current.renderedMs).toBe(50);
    expect(m.beacon.mock.calls.filter((c) => c[1] === 'live')).toHaveLength(1);
  });

  it('keeps a new sandbox and its key in memory, and stores the session', async () => {
    const none: Session = { kind: 'none', csrf: 'c', siteKey: 'sk' };
    const { result } = renderHook(() => useQuickstart(none));
    expect(result.current.client).toBeNull();
    await act(async () => result.current.sandboxMade(sandbox, 'KEY'));
    expect(result.current.secret).toBe('KEY');
    expect(result.current.sandbox).toEqual(sandbox);
    expect(m.updateSession).toHaveBeenCalledWith({
      kind: 'ready',
      csrf: 'c',
      sandbox,
      siteKey: 'sk',
    });
    expect(m.beacon).toHaveBeenCalledWith('c', 'sandbox');
  });

  it('reads the pass the server holds when the page has none', async () => {
    m.home.current = { passes: [{ id: 'p1', version: 3 }] };
    m.send.mockResolvedValue(ok(body(3), { status: 200 }));
    const { result } = renderHook(() => useQuickstart(ready));
    await waitFor(() => expect(result.current.pass?.version).toBe(3));
    expect(m.send.mock.calls[0]?.slice(0, 2)).toEqual(['GET', '/passes/p1']);
  });

  it('after a reload, the first call shows as sent when the server says the pass was made', async () => {
    m.home.current = {
      progress: { passAt: 5000 },
      passes: [],
      calls: [
        {
          method: 'POST',
          path: '/api/v1/passes',
          status: 201,
          durationMs: 40,
          requestId: 'r1',
          at: 4900,
          via: 'try',
          client: null,
        },
      ],
    };
    const { result } = renderHook(() => useQuickstart(ready));
    expect(result.current.run).toMatchObject({
      state: 'ok',
      status: 201,
      ms: 40,
      via: 'here',
      at: 4900,
    });
  });

  it('signed out: no client, no beacon, and create does nothing', async () => {
    const { result } = renderHook(() => useQuickstart({ kind: 'out' }));
    await act(() => result.current.create());
    expect(result.current.csrf).toBe('');
    expect(m.send).not.toHaveBeenCalled();
    expect(m.beacon).not.toHaveBeenCalled();
  });
});
