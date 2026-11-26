import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../../../lib/api.ts';
import { AppProviders } from '../../../lib/providers.tsx';
import { createQueryClient } from '../../../lib/query-client.ts';
import { stubFetch } from '../../../lib/test-utils.tsx';
import { templateDetail } from '../../passes/test-fixtures.ts';
import type { Template } from '../versions.ts';
import { Designer } from './designer.tsx';
import { sampleDoc } from './fixtures.ts';
import { adminHref, type DesignerHost, DesignerHostProvider } from './host.tsx';
import {
  ANONYMOUS_HOST,
  issueTestPass,
  releaseInTest,
  signedOutApi,
  workbenchDesignerHost,
} from './hosts.tsx';

const TEMPLATE = templateDetail() as unknown as Template;
/** An unsaved change, so a host that saves shows its Save bar. */
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

/** A Workbench token client stand-in: what it was asked, and nothing from the session client. */
function tokenClient() {
  const calls: string[] = [];
  const api = createApiClient({
    getCsrfToken: async () => undefined,
    fetch: async (input, init) => {
      const url = new URL(String(input), 'http://localhost');
      calls.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
      return new Response(JSON.stringify({ type: 'about:blank', status: 404, code: 'not_found' }), {
        status: 404,
        headers: { 'content-type': 'application/problem+json' },
      });
    },
  });
  return { api, calls };
}

const tenantCalls = (mock: ReturnType<typeof stubFetch>) =>
  mock.mock.calls
    .map(([input]) => new URL(String(input), 'http://localhost').pathname)
    .filter((path) => path.startsWith('/api/v1/') && path !== '/api/v1/session');

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('the designer in each host', () => {
  it('runs in the Workbench on its token client alone, in Test', async () => {
    const session = stubFetch({});
    const token = tokenClient();
    mount(workbenchDesignerHost({ orgId: 'org-wb', orgName: 'Northwind', api: token.api }));
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(TEMPLATE.name);
    await waitFor(() =>
      expect(token.calls).toContainEqual(
        expect.stringMatching(/^POST \/api\/v1\/templates\/[^/]+\/versions\?orgId=org-wb$/),
      ),
    );
    expect(token.calls).toContainEqual(expect.stringMatching(/^GET .*\/channels\?orgId=org-wb$/));
    expect(await screen.findByRole('button', { name: 'Save version' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: 'Scan screen' }));
    expect(await screen.findByRole('button', { name: 'Start blank' })).toBeInTheDocument();
    await waitFor(() =>
      expect(token.calls).toContainEqual(expect.stringMatching(/^GET \/api\/v1\/orgs\/org-wb\//)),
    );
    expect(tenantCalls(session)).toEqual([]);
  });

  it('runs signed out with no client, no save and no release step', async () => {
    const session = stubFetch({});
    mount(ANONYMOUS_HOST);
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(TEMPLATE.name);
    expect(screen.queryByRole('button', { name: 'Save version' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Release|Try|Review/ })).not.toBeInTheDocument();
    expect(tenantCalls(session)).toEqual([]);
    await expect(signedOutApi.get('/api/v1/templates', {} as never)).rejects.toThrow(
      'Sign in to design.',
    );
  });
});

describe('the Workbench host', () => {
  it('is Test only and never offers Live', () => {
    const host = workbenchDesignerHost({ orgId: 'org-wb', api: signedOutApi });
    expect(host.mode).toBe('test');
    expect(host.allows.publishLive).toBe(false);
  });

  it('releases to Test only', async () => {
    const post = vi.fn(async () => ({}));
    await releaseInTest({ ...signedOutApi, post } as never, 'org-wb', 'tpl 1', 'v1');
    expect(post).toHaveBeenCalledWith(
      '/api/v1/templates/tpl%201/release',
      expect.anything(),
      { orgId: 'org-wb', version: 'v1', modes: ['test'] },
      { headers: { 'idempotency-key': expect.any(String) } },
    );
  });

  it('issues a Test pass from the active Test release', async () => {
    const get = vi.fn(async () => ({ active: { id: 'rel1', version: 'v1', generation: 2 } }));
    const post = vi.fn(async () => ({ id: 'pass1' }));
    const api = { ...signedOutApi, get, post } as never;
    await issueTestPass(api, 'org-wb', { templateId: 't1', input: { name: 'Sam' } });
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

  it('refuses to issue before a Test release exists', async () => {
    const api = { ...signedOutApi, get: async () => ({ active: null }) } as never;
    await expect(issueTestPass(api, 'org-wb', { templateId: 't1', input: {} })).rejects.toThrow(
      'Release a version in Test first.',
    );
  });
});

describe('admin addresses', () => {
  it('names each place', () => {
    expect(adminHref({ to: 'zones' })).toBe('/admin/scanning?tab=zones');
    expect(adminHref({ to: 'template', templateId: 'a/b' })).toBe('/admin/templates/a%2Fb');
    expect(adminHref({ to: 'channels', templateId: 't1' }, { orgId: 'o1', mode: 'test' })).toBe(
      '/admin/templates/t1?tab=channels&orgId=o1&mode=test',
    );
  });
});
