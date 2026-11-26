import { afterEach, describe, expect, it, vi } from 'vitest';
import { startSandbox } from '../console/create.ts';
import { beacon } from './beacon.ts';
import { markViewed, readViewedAt } from './viewed.ts';

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('the page-view time', () => {
  it('is the first view of the session; a reload keeps it', () => {
    expect(readViewedAt()).toBeUndefined();
    const t = Date.now() - 1_000;
    expect(markViewed(t)).toBe(t);
    expect(markViewed(t + 500)).toBe(t);
    expect(readViewedAt()).toBe(t);
  });

  it('survives a new tab (local storage) but not a day', () => {
    const t = Date.now() - 5_000;
    markViewed(t);
    expect(sessionStorage.getItem('pb.developers.quickstart.viewedAt')).toBeNull();
    expect(readViewedAt()).toBe(t);
    localStorage.setItem('pb.developers.quickstart.viewedAt', String(Date.now() - 25 * 3_600_000));
    expect(readViewedAt()).toBeUndefined();
  });

  it('is absent, not an error, when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readViewedAt()).toBeUndefined();
    vi.restoreAllMocks();
  });

  it('rides on sandbox create, and only there', async () => {
    const at = Date.now() - 5_000;
    markViewed(at);
    const fetchFn = vi.fn(async () =>
      Response.json({ operation: { id: 'op', kind: 'sandbox.create' } }, { status: 202 }),
    );
    vi.stubGlobal('fetch', fetchFn);
    await startSandbox('csrf', 'token');
    const body = JSON.parse(
      String(
        (fetchFn.mock.calls[0] as unknown[])[1] &&
          ((fetchFn.mock.calls[0] as unknown[])[1] as RequestInit).body,
      ),
    );
    expect(Object.keys(body).sort()).toEqual(['turnstileToken', 'viewedAt']);
    expect(body.viewedAt).toBe(at);
  });
});

describe('the funnel beacon', () => {
  it('sends a step and, for a failure, its code: nothing else', () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchFn);
    beacon('csrf-1', 'run');
    beacon('csrf-1', 'fail', 'TEMPLATE_RELEASE_REQUIRED');
    const sent = fetchFn.mock.calls.map((c) => {
      const [url, init] = c as unknown as [string, RequestInit];
      return { url, init, body: JSON.parse(String(init.body)) };
    });
    expect(sent.map((s) => s.url)).toEqual(['/developers/beacon', '/developers/beacon']);
    expect(sent.map((s) => s.body)).toEqual([
      { step: 'run' },
      { step: 'fail', code: 'TEMPLATE_RELEASE_REQUIRED' },
    ]);
    expect(sent[0]?.init.keepalive).toBe(true);
  });

  it('never throws when the network is gone', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('offline'))),
    );
    expect(() => beacon('csrf', 'view')).not.toThrow();
    await Promise.resolve();
  });
});
