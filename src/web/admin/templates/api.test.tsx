import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSwatches } from '../../lib/swatches.ts';
import { templateDetail } from '../passes/test-fixtures.ts';
import {
  templateDetailQuery,
  templateKeys,
  useDraftPreview,
  useImportStatus,
  useTemplate,
  useTemplatePreview,
} from './api.ts';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const preview = (name: string) => ({
  passJson: { backgroundColor: name },
  warnings: [],
  assetBaseUrl: '/assets?rev=1&tag=a&tag=b#preview',
  assetNames: ['strip@2x.png'],
});

function harness(fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });
  const fetchMock = vi.fn(fetcher);
  vi.stubGlobal('fetch', fetchMock);
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return { client, fetchMock, wrapper: Wrapper };
}

afterEach(() => vi.unstubAllGlobals());

describe('template import status transport', () => {
  it('separates scoped and global imports while sharing the same-org query', async () => {
    const { client, fetchMock, wrapper } = harness(async (input) => {
      const url = new URL(String(input), 'http://localhost');
      const orgId = url.searchParams.get('orgId') ?? 'global';
      return json({
        uploadId: 'up1',
        status: 'complete',
        step: orgId,
        templateId: null,
        version: null,
        report: null,
        error: null,
      });
    });
    const { result } = renderHook(
      () => ({
        a: useImportStatus('up1', 'org-a'),
        duplicate: useImportStatus('up1', 'org-a'),
        b: useImportStatus('up1', 'org-b'),
        global: useImportStatus('up1', undefined),
      }),
      { wrapper },
    );
    await waitFor(() => {
      expect(result.current.a.data?.step).toBe('org-a');
      expect(result.current.duplicate.data?.step).toBe('org-a');
      expect(result.current.b.data?.step).toBe('org-b');
      expect(result.current.global.data?.step).toBe('global');
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const urls = fetchMock.mock.calls.map(([input]) => new URL(String(input), 'http://localhost'));
    expect(urls.every((url) => url.pathname === '/api/v1/templates/uploads/up1')).toBe(true);
    expect(urls.map((url) => url.searchParams.get('orgId'))).toEqual(['org-a', 'org-b', null]);
    expect(client.getQueryData(templateKeys.import('up1', 'org-a'))).toMatchObject({
      step: 'org-a',
    });
    expect(client.getQueryData(templateKeys.import('up1', 'org-b'))).toMatchObject({
      step: 'org-b',
    });
    expect(client.getQueryData(templateKeys.import('up1', undefined))).toMatchObject({
      step: 'global',
    });
  });

  it('does not poll a cleared upload and does not reuse another org’s report', async () => {
    const { fetchMock, wrapper } = harness(async (input) => {
      const orgId = new URL(String(input), 'http://localhost').searchParams.get('orgId');
      if (orgId !== 'org-a') return json({}, 404);
      return json({
        uploadId: 'up1',
        status: 'complete',
        step: 'org-a',
        templateId: null,
        version: null,
        report: null,
        error: null,
      });
    });
    const { result, rerender } = renderHook(
      ({ uploadId, orgId }: { uploadId: string | undefined; orgId: string | undefined }) =>
        useImportStatus(uploadId, orgId),
      { wrapper, initialProps: { uploadId: 'up1' as string | undefined, orgId: 'org-a' } },
    );
    await waitFor(() => expect(result.current.data?.step).toBe('org-a'));
    rerender({ uploadId: undefined, orgId: 'org-b' });
    expect(result.current.data).toBeUndefined();
    await act(async () => {
      await result.current.refetch();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    rerender({ uploadId: 'up1', orgId: 'org-b' });
    expect(result.current.data).toBeUndefined();
    await waitFor(() => expect(result.current.error).toMatchObject({ status: 404 }));
    expect(result.current.data).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('template detail transport', () => {
  it('isolates org-scoped and bare by-ID cache entries and requests', async () => {
    const { client, fetchMock, wrapper } = harness(async (input) => {
      const url = new URL(String(input), 'http://localhost');
      return json(templateDetail({ name: url.searchParams.get('orgId') ?? 'bare' }));
    });
    const { result, rerender } = renderHook(
      ({ orgId }: { orgId: string | undefined }) => useTemplate('tpl1', orgId),
      { wrapper, initialProps: { orgId: 'org-a' as string | undefined } },
    );
    await waitFor(() => expect(result.current.data?.name).toBe('org-a'));
    rerender({ orgId: 'org-b' });
    expect(result.current.data).toBeUndefined();
    await waitFor(() => expect(result.current.data?.name).toBe('org-b'));
    rerender({ orgId: undefined });
    expect(result.current.data).toBeUndefined();
    await waitFor(() => expect(result.current.data?.name).toBe('bare'));
    rerender({ orgId: 'org-a' });
    expect(result.current.data?.name).toBe('org-a');

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const urls = fetchMock.mock.calls.map(([input]) => new URL(String(input), 'http://localhost'));
    expect(urls.map((url) => url.pathname)).toEqual(Array(3).fill('/api/v1/templates/tpl1'));
    expect(urls.map((url) => url.searchParams.get('orgId'))).toEqual(['org-a', 'org-b', null]);
    expect(client.getQueryData(templateDetailQuery('tpl1', 'org-a').queryKey)).toMatchObject({
      name: 'org-a',
    });
    expect(client.getQueryData(templateDetailQuery('tpl1', 'org-b').queryKey)).toMatchObject({
      name: 'org-b',
    });
    expect(client.getQueryData(templateDetailQuery('tpl1').queryKey)).toMatchObject({
      name: 'bare',
    });
  });

  it('allows a denied bare lookup to retry with an explicit authorized org', async () => {
    const { fetchMock, wrapper } = harness(async (input) => {
      const orgId = new URL(String(input), 'http://localhost').searchParams.get('orgId');
      return orgId ? json(templateDetail({ name: orgId })) : json({}, 403);
    });
    const { result, rerender } = renderHook(
      ({ orgId }: { orgId: string | undefined }) => useTemplate('tpl1', orgId),
      { wrapper, initialProps: { orgId: undefined as string | undefined } },
    );
    await waitFor(() => expect(result.current.error).toMatchObject({ status: 403 }));
    expect(result.current.data).toBeUndefined();
    rerender({ orgId: 'org-a' });
    await waitFor(() => expect(result.current.data?.name).toBe('org-a'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not request details until an id is supplied', async () => {
    const { fetchMock, wrapper } = harness(async () => json(templateDetail()));
    const { result, rerender } = renderHook(
      ({ id }: { id: string | undefined }) => useTemplate(id),
      { wrapper, initialProps: { id: undefined as string | undefined } },
    );
    expect(fetchMock).not.toHaveBeenCalled();
    rerender({ id: 'tpl1' });
    await waitFor(() => expect(result.current.data?.id).toBe('tpl1'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('template preview transport', () => {
  it('shares same-org swatch queries but isolates other orgs and global previews', async () => {
    const { fetchMock, wrapper } = harness(async (input) => {
      const url = new URL(String(input), 'http://localhost');
      const org = url.searchParams.get('orgId') ?? 'global';
      const ids = url.searchParams.get('ids')?.split(',') ?? [];
      return json({ items: ids.map((id) => ({ id, ...preview(org) })) });
    });
    const { result, rerender } = renderHook(
      ({ orgId }: { orgId: string | undefined }) => ({
        full: useTemplatePreview('tpl1', orgId),
        swatches: useSwatches(['tpl1', 'tpl2'], orgId),
      }),
      { wrapper, initialProps: { orgId: 'org-a' as string | undefined } },
    );
    await waitFor(() => {
      expect(result.current.swatches.get('tpl2')?.background).toBe('org-a');
      expect(result.current.full.data?.passJson.backgroundColor).toBe('org-a');
      expect(result.current.swatches.get('tpl1')?.image).toBe(
        '/assets/strip%402x.png?rev=1&tag=a&tag=b&orgId=org-a#preview',
      );
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    rerender({ orgId: 'org-b' });
    expect(result.current.full.data).toBeUndefined();
    expect(result.current.swatches.size).toBe(0);
    await waitFor(() => {
      expect(result.current.swatches.get('tpl1')?.background).toBe('org-b');
      expect(result.current.full.data?.passJson.backgroundColor).toBe('org-b');
      expect(result.current.swatches.get('tpl1')?.image).toBe(
        '/assets/strip%402x.png?rev=1&tag=a&tag=b&orgId=org-b#preview',
      );
    });

    rerender({ orgId: undefined });
    expect(result.current.full.data).toBeUndefined();
    expect(result.current.swatches.size).toBe(0);
    await waitFor(() => {
      expect(result.current.swatches.get('tpl2')?.background).toBe('global');
      expect(result.current.full.data?.passJson.backgroundColor).toBe('global');
      expect(result.current.swatches.get('tpl1')?.image).toBe(
        '/assets/strip%402x.png?rev=1&tag=a&tag=b#preview',
      );
    });

    rerender({ orgId: 'org-a' });
    expect(result.current.swatches.get('tpl1')?.background).toBe('org-a');
    expect(result.current.full.data?.passJson.backgroundColor).toBe('org-a');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const urls = fetchMock.mock.calls.map(([input]) => new URL(String(input), 'http://localhost'));
    expect(urls.map((url) => url.searchParams.get('orgId'))).toEqual(['org-a', 'org-b', null]);
    expect(urls.map((url) => url.searchParams.get('ids'))).toEqual([
      'tpl1,tpl2',
      'tpl1,tpl2',
      'tpl1,tpl2',
    ]);
  });

  it('does not request previews for an empty selection', () => {
    const { fetchMock, wrapper } = harness(async () => json({ items: [] }));
    const { result } = renderHook(
      () => ({ full: useTemplatePreview('', 'org-a'), swatches: useSwatches([], 'org-a') }),
      { wrapper },
    );
    expect(result.current.full.data).toBeUndefined();
    expect(result.current.swatches.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keys version previews by org and version and sends scoped POSTs', async () => {
    const { fetchMock, wrapper } = harness(async (input, init) => {
      const url = new URL(String(input), 'http://localhost');
      const org = url.searchParams.get('orgId');
      if (org === 'denied') return json({}, 403);
      const body = JSON.parse(String(init?.body)) as { version: string; orgId?: string };
      return json(preview(`${body.orgId ?? 'global'}:${body.version}`));
    });
    const { result, rerender } = renderHook(
      ({ orgId, version }: { orgId: string | undefined; version: string }) =>
        useTemplatePreview('tpl1', orgId, version),
      { wrapper, initialProps: { orgId: 'org-a' as string | undefined, version: 'v1' } },
    );
    await waitFor(() => expect(result.current.data?.passJson.backgroundColor).toBe('org-a:v1'));
    expect(result.current.data?.assetBaseUrl).toBe('/assets?rev=1&tag=a&tag=b&orgId=org-a#preview');
    rerender({ orgId: 'org-a', version: 'v2' });
    expect(result.current.data).toBeUndefined();
    await waitFor(() => expect(result.current.data?.passJson.backgroundColor).toBe('org-a:v2'));
    rerender({ orgId: 'org-b', version: 'v2' });
    expect(result.current.data).toBeUndefined();
    await waitFor(() => expect(result.current.data?.passJson.backgroundColor).toBe('org-b:v2'));
    rerender({ orgId: 'denied', version: 'v2' });
    expect(result.current.data).toBeUndefined();
    await waitFor(() => expect(result.current.error).toMatchObject({ status: 403 }));
    expect(result.current.data).toBeUndefined();
    rerender({ orgId: undefined, version: 'v2' });
    await waitFor(() => expect(result.current.data?.passJson.backgroundColor).toBe('global:v2'));
    expect(result.current.data?.assetBaseUrl).toBe('/assets?rev=1&tag=a&tag=b#preview');
    rerender({ orgId: 'org-a', version: 'v1' });
    expect(result.current.data?.passJson.backgroundColor).toBe('org-a:v1');

    expect(fetchMock).toHaveBeenCalledTimes(5);
    const requests = fetchMock.mock.calls.map(([input, init]) => ({
      url: new URL(String(input), 'http://localhost'),
      method: init?.method,
      body: JSON.parse(String(init?.body)) as { version: string; orgId?: string },
    }));
    expect(requests.map(({ url }) => url.searchParams.get('orgId'))).toEqual([
      'org-a',
      'org-a',
      'org-b',
      'denied',
      null,
    ]);
    expect(
      requests.every(
        ({ url, method }) => url.pathname === '/api/v1/templates/tpl1/preview' && method === 'POST',
      ),
    ).toBe(true);
    expect(requests.map(({ body }) => body)).toEqual([
      { version: 'v1', orgId: 'org-a' },
      { version: 'v2', orgId: 'org-a' },
      { version: 'v2', orgId: 'org-b' },
      { version: 'v2', orgId: 'denied' },
      { version: 'v2' },
    ]);
  });

  it('keeps draft placeholders within the same org, template, and version', async () => {
    const pending = new Map<string, (response: Response) => void>();
    const { fetchMock, wrapper } = harness(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        input: { name: string };
        orgId?: string;
        version?: string;
      };
      if (body.input.name === 'first') return json(preview('first'));
      // The web target is ES2023, before Promise.withResolvers.
      return new Promise<Response>((resolve) => pending.set(body.input.name, resolve));
    });
    const { result, rerender } = renderHook(
      ({
        id,
        orgId,
        version,
        name,
      }: {
        id: string;
        orgId: string;
        version: string;
        name: string;
      }) => useDraftPreview(id, { name }, { orgId, version }),
      { wrapper, initialProps: { id: 'tpl1', orgId: 'org-a', version: 'v1', name: 'first' } },
    );
    await waitFor(() => expect(result.current.data?.passJson.backgroundColor).toBe('first'));
    expect(result.current.data?.assetBaseUrl).toBe('/assets?rev=1&tag=a&tag=b&orgId=org-a#preview');
    rerender({ id: 'tpl1', orgId: 'org-a', version: 'v1', name: 'second' });
    expect(result.current.data?.passJson.backgroundColor).toBe('first');
    await waitFor(() => expect(pending.has('second')).toBe(true));
    rerender({ id: 'tpl1', orgId: 'org-a', version: 'v2', name: 'third' });
    expect(result.current.data).toBeUndefined();
    await waitFor(() => expect(pending.has('third')).toBe(true));
    await act(async () => pending.get('third')?.(json(preview('third'))));
    await waitFor(() => expect(result.current.data?.passJson.backgroundColor).toBe('third'));
    rerender({ id: 'tpl1', orgId: 'org-b', version: 'v2', name: 'fourth' });
    expect(result.current.data).toBeUndefined();
    await waitFor(() => expect(pending.has('fourth')).toBe(true));
    await act(async () => pending.get('fourth')?.(json(preview('fourth'))));
    await waitFor(() => expect(result.current.data?.passJson.backgroundColor).toBe('fourth'));
    expect(result.current.data?.assetBaseUrl).toBe('/assets?rev=1&tag=a&tag=b&orgId=org-b#preview');
    rerender({ id: 'tpl2', orgId: 'org-b', version: 'v2', name: 'fifth' });
    expect(result.current.data).toBeUndefined();
    await waitFor(() => expect(pending.has('fifth')).toBe(true));
    await act(async () => {
      pending.get('second')?.(json(preview('second')));
      pending.get('fifth')?.(json(preview('fifth')));
    });
    await waitFor(() => expect(result.current.data?.passJson.backgroundColor).toBe('fifth'));
    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies).toEqual([
      { input: { name: 'first' }, orgId: 'org-a', version: 'v1' },
      { input: { name: 'second' }, orgId: 'org-a', version: 'v1' },
      { input: { name: 'third' }, orgId: 'org-a', version: 'v2' },
      { input: { name: 'fourth' }, orgId: 'org-b', version: 'v2' },
      { input: { name: 'fifth' }, orgId: 'org-b', version: 'v2' },
    ]);
  });

  it('leaves global draft preview assets unscoped', async () => {
    const { wrapper } = harness(async () => json(preview('global')));
    const { result } = renderHook(() => useDraftPreview('tpl1', {}), { wrapper });
    await waitFor(() => expect(result.current.data?.passJson.backgroundColor).toBe('global'));
    expect(result.current.data?.assetBaseUrl).toBe('/assets?rev=1&tag=a&tag=b#preview');
  });
});
