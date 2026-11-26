import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../lib/errors.ts';
import { AppProviders } from '../../../lib/providers.tsx';
import { createQueryClient } from '../../../lib/query-client.ts';
import '../../../lib/test-utils.tsx';
import type { ToolApi } from '../../../lib/tool-api.tsx';
import { templateDetail } from '../../passes/test-fixtures.ts';
import type { Template } from '../versions.ts';
import { Designer } from './designer.tsx';
import { DesignerHostProvider } from './host.tsx';
import { useWorkbenchDesignerHost, type WorkbenchClient } from './hosts.tsx';
import type { DesignDoc } from './model.ts';
import { forgetStageMemory } from './scan/scan-stage-memory.ts';

const DIR = join(process.cwd(), 'templates', 'starter-stamp-card');
const PNG = readFileSync(join(DIR, 'logo@2x.png'));
const SHA = 'a'.repeat(40);
const ORG = 'org-wb';
const TEMPLATE = templateDetail({ orgId: ORG }) as unknown as Template;

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.png') ? [join(dir, e.name)] : [],
  );
}

/** The Stamp card: stamps, paper, Scan screen, wallets and the org's own logo and icon. */
const DOC: DesignDoc = {
  passJson: JSON.parse(readFileSync(join(DIR, 'pass.json'), 'utf8')),
  manifest: JSON.parse(readFileSync(join(DIR, 'wallet.template.json'), 'utf8')),
  assets: files(DIR).map((path) => ({
    name: relative(DIR, path),
    slot: 'source',
    scale: 1,
    size: PNG.length,
    sha1: SHA,
  })),
};

const BRAND = {
  logo: { source: 'org', value: { sha: SHA } },
  icon: { source: 'org', value: { sha: SHA } },
  passColors: { source: 'template', value: null },
};

/** What the token client is asked, with the headers it was given. */
function tokenClient() {
  const calls: { method: string; path: string; headers: Record<string, string> }[] = [];
  const answer =
    (method: string) =>
    async (path: string, ...rest: unknown[]) => {
      const opts = (rest.at(-1) ?? {}) as { headers?: Record<string, string> };
      calls.push({ method, path, headers: opts.headers ?? {} });
      if (path.endsWith('/versions') && method === 'POST')
        return { report: { ok: true, issues: [] }, passJson: DOC.passJson, assets: [] };
      if (path.endsWith('/pass-setup')) return { brand: BRAND };
      if (path.endsWith('/workspace'))
        return { name: 'Northwind', branding: { accent: null, logo: { sha: SHA } } };
      if (path === '/api/v1/settings' || path === '/api/v1/scan-zones') return { items: [] };
      if (path === '/api/v1/passes')
        return { items: [{ id: 'pass-1', serial: 'S-1', title: 'Pass one' }], nextCursor: null };
      throw new ApiError({ status: 404, code: 'not_found', detail: 'Not found.' });
    };
  const api: ToolApi = {
    get: answer('GET') as ToolApi['get'],
    post: answer('POST') as ToolApi['post'],
    put: answer('PUT') as ToolApi['put'],
    patch: answer('PATCH') as ToolApi['patch'],
    deleteJson: answer('DELETE') as ToolApi['deleteJson'],
    delete: answer('DELETE') as unknown as ToolApi['delete'],
    action: answer('ACTION') as unknown as ToolApi['action'],
  };
  const client: WorkbenchClient = { kind: 'workbench-token', api, token: async () => 'tok' };
  return { client, calls };
}

function Mounted({ client }: { client: WorkbenchClient }) {
  const host = useWorkbenchDesignerHost({ orgId: ORG, orgName: 'Northwind', client });
  return (
    <DesignerHostProvider host={host}>
      <Designer
        template={TEMPLATE}
        draftKey="runtime"
        base={{ version: 'v1', doc: DOC }}
        draft={null}
        assetBase={(v) => `/api/v1/templates/${TEMPLATE.id}/versions/${v}/assets?orgId=${ORG}`}
      />
    </DesignerHostProvider>
  );
}

let made = 0;
beforeEach(() => {
  forgetStageMemory();
  Object.assign(URL, {
    createObjectURL: vi.fn(() => `blob:test/${++made}`),
    revokeObjectURL: vi.fn(),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  Object.assign(URL, { createObjectURL: undefined, revokeObjectURL: undefined });
  localStorage.clear();
});

describe('the Workbench host at runtime', () => {
  it('sends every call and file with the token, never with a mode header', async () => {
    const network = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      return path.includes('/assets/') || path.includes('/branding/')
        ? new Response(PNG, { headers: { 'content-type': 'image/png' } })
        : new Response(null, { status: 404 });
    });
    vi.stubGlobal('fetch', network);
    const token = tokenClient();
    const queryClient = createQueryClient();
    queryClient.setDefaultOptions({ queries: { retry: false } });
    const root = createRootRoute({ component: () => <Mounted client={token.client} /> });
    const router = createRouter({
      routeTree: root,
      history: createMemoryHistory({ initialEntries: ['/'] }),
    });
    render(
      <AppProviders queryClient={queryClient}>
        <RouterProvider router={router} />
      </AppProviders>,
    );
    const user = userEvent.setup();

    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(TEMPLATE.name);
    // Template files, the stamp art and the org's logo and icon load as bytes on the bearer.
    await waitFor(() => expect(network.mock.calls.length).toBeGreaterThan(3));
    await user.click(await screen.findByRole('radio', { name: /Wallets/ }));
    await user.click(await screen.findByRole('radio', { name: 'Scan screen' }));
    await user.click(await screen.findByRole('button', { name: 'Start blank' }));
    await user.click(await screen.findByRole('combobox', { name: /^Sample/ }));
    await user.click(await screen.findByRole('option', { name: 'Real pass' }));
    await user.click(await screen.findByRole('combobox', { name: /^Pass/ }));
    await user.type(await screen.findByPlaceholderText('Search passes'), 'Pass');
    expect(await screen.findByRole('option', { name: 'Pass one' })).toBeInTheDocument();

    const paths = token.calls.map((c) => `${c.method} ${c.path}`);
    expect(paths).toContain('POST /api/v1/templates/tpl1/versions');
    expect(paths).toContain(`GET /api/v1/orgs/${ORG}/pass-setup`);
    expect(paths).toContain(`GET /api/v1/orgs/${ORG}/workspace`);
    expect(paths).toContain('GET /api/v1/passes');
    for (const call of token.calls)
      expect(Object.keys(call.headers).map((h) => h.toLowerCase())).not.toContain(
        'x-passbook-mode',
      );

    // The page itself fetched only files, each with the bearer and no mode header.
    expect(network.mock.calls.length).toBeGreaterThan(0);
    for (const [input, init] of network.mock.calls as unknown as [RequestInfo, RequestInit][]) {
      const url = new URL(String(input), 'http://localhost');
      expect(url.pathname).toMatch(/\/(assets|branding)\//);
      const headers = new Headers(init.headers);
      expect(headers.get('authorization')).toBe('Bearer tok');
      expect(headers.get('x-passbook-mode')).toBeNull();
    }

    // No image points at an address the browser would load without the token.
    for (const img of document.querySelectorAll('img')) {
      const src = img.getAttribute('src') ?? '';
      expect(src === '' || /^(blob|data):/.test(src)).toBe(true);
    }
  });
});
