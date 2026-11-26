import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { render, renderHook, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppProviders } from '../../../lib/providers.tsx';
import { createQueryClient } from '../../../lib/query-client.ts';
import { stubFetch } from '../../../lib/test-utils.tsx';
import type { ToolApi } from '../../../lib/tool-api.tsx';
import { templateDetail } from '../../passes/test-fixtures.ts';
import type { Template } from '../versions.ts';
import { Designer } from './designer.tsx';
import { sampleDoc } from './fixtures.ts';
import { adminHref, type DesignerHost, DesignerHostProvider, useDesignerHost } from './host.tsx';
import {
  anonymousDesignerHost,
  issueTestPass,
  releaseInTest,
  type WorkbenchClient,
  workbenchDesignerHost,
} from './hosts.tsx';

const TEMPLATE = templateDetail() as unknown as Template;
/** An unsaved change, so a host that saves would show its Save bar. */
const DRAFT = { ...sampleDoc(), manifest: { ...sampleDoc().manifest, name: 'Changed' } };

function mount(host: DesignerHost) {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const root = createRootRoute({
    component: () => (
      <DesignerHostProvider host={host}>
        <Designer
          template={TEMPLATE}
          draftKey="hosts-test"
          base={{ version: TEMPLATE.versions[0]?.version ?? '', doc: sampleDoc() }}
          draft={DRAFT}
          assetBase={() => '/assets'}
        />
      </DesignerHostProvider>
    ),
  });
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  render(
    <AppProviders queryClient={queryClient}>
      <RouterProvider router={router} />
    </AppProviders>,
  );
}

const refusing = () => Promise.reject(new Error('not called'));
const stubApi = (over: Partial<ToolApi> = {}): ToolApi =>
  ({
    get: refusing,
    post: refusing,
    put: refusing,
    patch: refusing,
    deleteJson: refusing,
    delete: refusing,
    action: refusing,
    ...over,
  }) as ToolApi;
const client = (api = stubApi()): WorkbenchClient => ({
  kind: 'workbench-token',
  api,
  token: async () => 'tok',
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('the anonymous host', () => {
  it('is read only: no save, no draft kept, nothing on the network', async () => {
    const session = stubFetch({});
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    mount(anonymousDesignerHost({}));
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(TEMPLATE.name);
    expect(screen.queryByRole('button', { name: 'Save version' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
    expect(screen.getByTestId('designer-layout').querySelector('[inert]')).not.toBeNull();
    await new Promise((r) => setTimeout(r, 900));
    expect(setItem.mock.calls.filter(([key]) => String(key).includes('hosts-test'))).toEqual([]);
    expect(session).not.toHaveBeenCalled();
    setItem.mockRestore();
  });

  it("serves files from the blueprint's own bundle and nothing else", async () => {
    const logo = new Blob(['png']);
    const host = anonymousDesignerHost({ 'logo@2x.png': logo });
    await expect(host.loadAsset('/x/versions/v/assets/logo%402x.png?orgId=o')).resolves.toBe(logo);
    await expect(host.loadAsset('/x/assets/strip.png')).rejects.toMatchObject({ status: 404 });
    await expect(host.api.get('/api/v1/templates', {} as never)).rejects.toThrow(
      'Sign in to design.',
    );
    expect(host.Link).toBeNull();
    expect(host.allows).toEqual({ edit: false, save: false, publishLive: false });
  });
});

describe('the Workbench host', () => {
  it('is Test only and never offers Live', () => {
    const host = workbenchDesignerHost({ orgId: 'org-wb', client: client() });
    expect(host.mode).toBe('test');
    expect(host.allows.publishLive).toBe(false);
  });

  it('loads files on the bearer', async () => {
    const network = vi.fn(async () => new Response('png'));
    vi.stubGlobal('fetch', network);
    await workbenchDesignerHost({ orgId: 'org-wb', client: client() }).loadAsset('/a.png');
    expect(network).toHaveBeenCalledWith('/a.png', {
      headers: { authorization: 'Bearer tok' },
      credentials: 'same-origin',
    });
  });

  it('releases to Test only, under the caller key for the attempt', async () => {
    const post = vi.fn(async () => ({}));
    await releaseInTest(stubApi({ post } as never), 'org-wb', 'tpl 1', 'v1', 'key-1');
    expect(post).toHaveBeenCalledWith(
      '/api/v1/templates/tpl%201/release',
      expect.anything(),
      { orgId: 'org-wb', version: 'v1', modes: ['test'] },
      { headers: { 'idempotency-key': 'key-1' } },
    );
  });

  it('issues a Test pass from the active Test release', async () => {
    const get = vi.fn(async () => ({ active: { id: 'rel1', version: 'v1', generation: 2 } }));
    const post = vi.fn(async () => ({ id: 'pass1' }));
    await issueTestPass(stubApi({ get, post } as never), 'org-wb', {
      templateId: 't1',
      input: { name: 'Sam' },
    });
    expect(get).toHaveBeenCalledWith('/api/v1/templates/t1/releases', expect.anything(), {
      query: { orgId: 'org-wb', mode: 'test', provider: 'apple' },
    });
    expect(post).toHaveBeenCalledWith(
      '/api/v1/passes',
      expect.anything(),
      expect.objectContaining({ mode: 'test', releaseId: 'rel1', releaseGeneration: 2 }),
      expect.anything(),
    );
  });

  it('refuses to issue before a Test release exists, with a stable code', async () => {
    const api = stubApi({ get: (async () => ({ active: null })) as never });
    await expect(
      issueTestPass(api, 'org-wb', { templateId: 't1', input: {} }),
    ).rejects.toMatchObject({ code: 'no_test_release', status: 409 });
  });
});

describe('outside a host', () => {
  it('is standalone: no client, no files, no edits', async () => {
    const { result } = renderHook(() => useDesignerHost());
    expect(result.current.kind).toBe('standalone');
    expect(result.current.allows.edit).toBe(false);
    await expect(result.current.api.get('/api/v1/x', {} as never)).rejects.toMatchObject({
      status: 401,
    });
    await expect(result.current.loadAsset('/a.png')).rejects.toMatchObject({ status: 404 });
  });
});

describe('admin addresses', () => {
  it('names each place', () => {
    expect(adminHref({ to: 'zones' })).toBe('/admin/scanning?tab=zones');
    expect(adminHref({ to: 'template', templateId: 'a/b' }, 'o1')).toBe(
      '/admin/templates/a%2Fb?orgId=o1',
    );
    expect(
      adminHref({ to: 'channels', templateId: 't1' }, 'o1', { orgId: 'o1', mode: 'test' }),
    ).toBe('/admin/templates/t1?tab=channels&orgId=o1&mode=test');
  });
});
