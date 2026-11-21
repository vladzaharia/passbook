import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSandbox } from '../console/create.ts';
import { beacon } from './beacon.ts';
import { markViewed, readViewedAt } from './viewed.ts';

afterEach(() => {
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe('the page-view time', () => {
  it('is the first view of the session; a reload keeps it', () => {
    expect(readViewedAt()).toBeUndefined();
    expect(markViewed(1_000)).toBe(1_000);
    expect(markViewed(9_000)).toBe(1_000);
    expect(readViewedAt()).toBe(1_000);
  });

  it('is absent, not an error, when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readViewedAt()).toBeUndefined();
    vi.restoreAllMocks();
  });

  it('rides on sandbox create, and only there', async () => {
    markViewed(5_000);
    const fetchFn = vi.fn(async () =>
      Response.json({ id: 's', orgSlug: 'dev-x', templateId: 't', key: null }, { status: 201 }),
    );
    vi.stubGlobal('fetch', fetchFn);
    await createSandbox('csrf', 'token');
    const body = JSON.parse(
      String(
        (fetchFn.mock.calls[0] as unknown[])[1] &&
          ((fetchFn.mock.calls[0] as unknown[])[1] as RequestInit).body,
      ),
    );
    expect(Object.keys(body).sort()).toEqual(['turnstileToken', 'viewedAt']);
    expect(body.viewedAt).toBe(5_000);
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
