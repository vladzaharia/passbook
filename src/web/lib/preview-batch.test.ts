import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearOrgPreviewBatches, clearPreviewBatches, fetchPreview } from './preview-batch.ts';

const preview = (id: string, org = 'global') => ({
  id,
  passJson: { backgroundColor: 'rgb(1,2,3)', organizationName: org },
  warnings: [],
  assetBaseUrl: `/api/v1/templates/${id}/versions/v1/assets`,
  assetNames: [],
});
const response = (items: unknown[]) =>
  new Response(JSON.stringify({ items }), { headers: { 'content-type': 'application/json' } });

afterEach(() => {
  clearPreviewBatches();
  vi.unstubAllGlobals();
});

describe('fetchPreview', () => {
  it('batches and deduplicates same-org ids, rejecting missing previews', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
      response([preview('t1'), preview('t2')]),
    );
    vi.stubGlobal('fetch', fetchMock);
    const [a, duplicate, b, missing] = await Promise.allSettled([
      fetchPreview('t1', 'org-a'),
      fetchPreview('t1', 'org-a'),
      fetchPreview('t2', 'org-a'),
      fetchPreview('t3', 'org-a'),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]), 'http://localhost');
    expect(url.searchParams.get('ids')).toBe('t1,t2,t3');
    expect(url.searchParams.get('orgId')).toBe('org-a');
    expect(a).toMatchObject({ status: 'fulfilled', value: { id: 't1' } });
    expect(duplicate).toMatchObject({ status: 'fulfilled', value: { id: 't1' } });
    expect(b).toMatchObject({ status: 'fulfilled', value: { id: 't2' } });
    expect(missing).toMatchObject({
      status: 'rejected',
      reason: { status: 404, code: 'TEMPLATE_NOT_FOUND' },
    });
  });

  it('isolates ids and responses across organizations and explicit global previews', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      const org = url.searchParams.get('orgId') ?? 'global';
      const ids = url.searchParams.get('ids')?.split(',') ?? [];
      return response(ids.map((id) => preview(id, org)));
    });
    vi.stubGlobal('fetch', fetchMock);
    const [a, b, global] = await Promise.all([
      fetchPreview('shared', 'org-a'),
      fetchPreview('shared', 'org-b'),
      fetchPreview('shared', undefined),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect([a, b, global].map((p) => p.passJson.organizationName)).toEqual([
      'org-a',
      'org-b',
      'global',
    ]);
  });

  it('scopes asset URLs while retaining query parameters and fragments', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        response([
          {
            ...preview('shared'),
            assetBaseUrl: '/assets?rev=1&orgId=old&tag=a&tag=b#preview',
          },
        ]),
      ),
    );
    const [scoped, global] = await Promise.all([
      fetchPreview('shared', 'org a/&'),
      fetchPreview('shared', undefined),
    ]);
    const asset = new URL(scoped.assetBaseUrl, 'http://localhost');
    expect(asset.pathname).toBe('/assets');
    expect(asset.searchParams.get('rev')).toBe('1');
    expect(asset.searchParams.getAll('tag')).toEqual(['a', 'b']);
    expect(asset.searchParams.getAll('orgId')).toEqual(['org a/&']);
    expect(asset.hash).toBe('#preview');
    expect(global.assetBaseUrl).toBe('/assets?rev=1&orgId=old&tag=a&tag=b#preview');
  });

  it('does not resolve a missing preview from another organization', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const orgId = new URL(String(input), 'http://localhost').searchParams.get('orgId');
        return response(orgId === 'org-b' ? [preview('shared', 'org-b')] : []);
      }),
    );
    const [a, b] = await Promise.allSettled([
      fetchPreview('shared', 'org-a'),
      fetchPreview('shared', 'org-b'),
    ]);
    expect(a).toMatchObject({ status: 'rejected', reason: { status: 404 } });
    expect(b).toMatchObject({
      status: 'fulfilled',
      value: { passJson: { organizationName: 'org-b' } },
    });
  });

  it('isolates request failures and invalid responses by organization', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const org = new URL(String(input), 'http://localhost').searchParams.get('orgId');
      if (org === 'org-a') return new Response('Forbidden', { status: 403 });
      if (org === 'org-b')
        return new Response(JSON.stringify({ items: 'invalid' }), {
          headers: { 'content-type': 'application/json' },
        });
      return response([preview('shared')]);
    });
    vi.stubGlobal('fetch', fetchMock);
    const [a, duplicate, b, global] = await Promise.allSettled([
      fetchPreview('shared', 'org-a'),
      fetchPreview('shared', 'org-a'),
      fetchPreview('shared', 'org-b'),
      fetchPreview('shared', undefined),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(a).toMatchObject({ status: 'rejected', reason: { status: 403 } });
    expect(duplicate).toMatchObject({ status: 'rejected', reason: { status: 403 } });
    expect(b).toMatchObject({ status: 'rejected', reason: { code: 'invalid_response' } });
    expect(global).toMatchObject({ status: 'fulfilled', value: { id: 'shared' } });
  });

  it('limits each request to 50 ids and continues after a chunk fails', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      const ids = url.searchParams.get('ids')?.split(',') ?? [];
      if (ids.includes('t0')) return new Response('Unavailable', { status: 503 });
      return response(ids.map((id) => preview(id)));
    });
    vi.stubGlobal('fetch', fetchMock);
    const results = await Promise.allSettled(
      Array.from({ length: 51 }, (_, i) => fetchPreview(`t${i}`, 'org-a')),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(results.slice(0, 50).every((result) => result.status === 'rejected')).toBe(true);
    expect(results[50]).toMatchObject({ status: 'fulfilled', value: { id: 't50' } });
  });

  it('rejects queued previews before they can use a different principal', async () => {
    const fetchMock = vi.fn(async () => response([preview('t1')]));
    vi.stubGlobal('fetch', fetchMock);
    const queued = fetchPreview('t1', 'org-a').catch((error: unknown) => error);
    clearPreviewBatches();
    expect(await queued).toMatchObject({ name: 'AbortError' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('aborts in-flight requests and never resolves their late response after a principal switch', async () => {
    const deferred = Promise as PromiseConstructor & {
      withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void };
    };
    const oldResponse = deferred.withResolvers<Response>();
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => oldResponse.promise)
      .mockImplementationOnce(() => response([preview('t1', 'new')]));
    vi.stubGlobal('fetch', fetchMock);
    const old = fetchPreview('t1', 'org-a').catch((error: unknown) => error);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    if (!init) throw new Error('Expected the preview fetch request.');
    const signal = init.signal;
    clearPreviewBatches();
    expect(signal?.aborted).toBe(true);
    expect(await old).toMatchObject({ name: 'AbortError' });
    oldResponse.resolve(response([preview('t1', 'old')]));
    const current = await fetchPreview('t1', 'org-a');
    expect(current.passJson.organizationName).toBe('new');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('cancels only the departed organization when the workspace changes', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const org = new URL(String(input), 'http://localhost').searchParams.get('orgId');
      return response([preview('shared', org ?? 'global')]);
    });
    vi.stubGlobal('fetch', fetchMock);
    const old = fetchPreview('shared', 'org-a').catch((error: unknown) => error);
    const current = fetchPreview('shared', 'org-b');
    clearOrgPreviewBatches('org-a');
    expect(await old).toMatchObject({ name: 'AbortError' });
    expect((await current).passJson.organizationName).toBe('org-b');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('aborts only the departed organization’s in-flight batch', async () => {
    const deferred = Promise as PromiseConstructor & {
      withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void };
    };
    const oldResponse = deferred.withResolvers<Response>();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const org = new URL(String(input), 'http://localhost').searchParams.get('orgId');
      return org === 'org-a' ? oldResponse.promise : response([preview('shared', 'org-b')]);
    });
    vi.stubGlobal('fetch', fetchMock);
    const old = fetchPreview('shared', 'org-a').catch((error: unknown) => error);
    const current = fetchPreview('shared', 'org-b');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const oldCall = fetchMock.mock.calls.find(
      ([input]) => new URL(String(input), 'http://localhost').searchParams.get('orgId') === 'org-a',
    );
    clearOrgPreviewBatches('org-a');
    expect(oldCall?.[1]?.signal?.aborted).toBe(true);
    expect(await old).toMatchObject({ name: 'AbortError' });
    expect((await current).passJson.organizationName).toBe('org-b');
    oldResponse.resolve(response([preview('shared', 'org-a')]));
  });
});
