import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/errors.ts';
import { AppProviders } from '../../lib/providers.tsx';
import { createQueryClient } from '../../lib/query-client.ts';
import '../../lib/test-utils.tsx';
import { templateDetail } from '../../admin/passes/test-fixtures.ts';
import { Designer } from '../../admin/templates/designer/designer.tsx';
import { DesignerHostProvider } from '../../admin/templates/designer/host.tsx';
import {
  useWorkbenchDesignerHost,
  type WorkbenchClient,
} from '../../admin/templates/designer/hosts.tsx';
import type { DesignDoc } from '../../admin/templates/designer/model.ts';
import { forgetStageMemory } from '../../admin/templates/designer/scan/scan-stage-memory.ts';
import type { Template } from '../../admin/templates/versions.ts';
import type { ToolApi } from '../../lib/tool-api.tsx';
import { DESIGN_EXTRAS } from './extras.tsx';
import { TemplateProvider } from './template-context.tsx';

let kind: 'org' | 'sandbox' = 'org';
vi.mock('../host/tool-host.tsx', () => ({
  useOptionalToolHost: () => ({ context: { kind, orgId: 'org-wb' } }),
}));

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

function tokenClient() {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const answer =
    (method: string) =>
    async (path: string, ...rest: unknown[]) => {
      calls.push({ method, path, body: method === 'POST' ? rest[1] : undefined });
      if (path.endsWith('/versions') && method === 'POST')
        return { report: { ok: true, issues: [] }, passJson: DOC.passJson, assets: [] };
      if (path.endsWith('/pass-setup')) return { brand: BRAND };
      if (path.endsWith('/workspace'))
        return { name: 'Northwind', branding: { accent: null, logo: { sha: SHA } } };
      if (path === '/api/v1/settings' || path === '/api/v1/scan-zones') return { items: [] };
      if (path.endsWith('/releases'))
        return { active: { id: 'rel-1', version: 'v1', generation: 1 }, items: [] };
      if (path === '/api/v1/passes' && method === 'POST')
        return { id: 'pass-new', downloadUrl: '/p/dl-token' };
      throw new ApiError({ status: 404, code: 'not_found', detail: 'Not found.' });
    };
  const api = {
    get: answer('GET'),
    post: answer('POST'),
    put: answer('PUT'),
    patch: answer('PATCH'),
    deleteJson: answer('DELETE'),
    delete: answer('DELETE'),
    action: answer('ACTION'),
  } as unknown as ToolApi;
  const client: WorkbenchClient = { kind: 'workbench-token', api, token: async () => 'tok' };
  return { client, calls };
}

function Mounted({ client }: { client: WorkbenchClient }) {
  const host = useWorkbenchDesignerHost({
    orgId: ORG,
    orgName: 'Northwind',
    client,
    extras: DESIGN_EXTRAS,
  });
  return (
    <DesignerHostProvider host={host}>
      <TemplateProvider value={{ id: TEMPLATE.id, name: TEMPLATE.name }}>
        <Designer
          template={TEMPLATE}
          draftKey="wb-extras"
          base={{ version: 'v1', doc: DOC }}
          draft={null}
          assetBase={(v) => `/api/v1/templates/${TEMPLATE.id}/versions/${v}/assets?orgId=${ORG}`}
        />
      </TemplateProvider>
    </DesignerHostProvider>
  );
}

function mount() {
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
  return token;
}

beforeEach(() => {
  forgetStageMemory();
  kind = 'org';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      return path.includes('/assets/') || path.includes('/branding/')
        ? new Response(PNG, { headers: { 'content-type': 'image/png' } })
        : new Response(null, { status: 404 });
    }),
  );
  let n = 0;
  Object.assign(URL, {
    createObjectURL: vi.fn(() => `blob:test/${++n}`),
    revokeObjectURL: vi.fn(),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  Object.assign(URL, { createObjectURL: undefined, revokeObjectURL: undefined });
  localStorage.clear();
});

describe('Design in the Workbench', () => {
  it('takes the page head from the shell: the core adds no second h1', async () => {
    mount();
    expect(await screen.findByRole('tab', { name: 'Data' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
  });

  it('edits the sample as JSON and the code follows', async () => {
    mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /JSON/ }));
    const box = await screen.findByRole('textbox', { name: 'Sample as JSON' });
    fireEvent.change(box, { target: { value: '{"name":"Zed Test"}' } });
    await waitFor(() => expect(screen.getAllByText(/Zed Test/).length).toBeGreaterThan(1));
    fireEvent.change(box, { target: { value: '[1]' } });
    expect(await screen.findByText('The sample is an object.')).toBeInTheDocument();
  });

  it('keeps the section editor mounted behind its tab', async () => {
    mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'Design' }));
    expect(await screen.findByRole('tabpanel', { name: 'Design' })).toBeVisible();
  });

  it('issues a test pass from the Test release and shows its link as a QR in an org', async () => {
    const token = mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Try on my phone' }));
    const dialog = await screen.findByRole('dialog', { name: 'Try on my phone' });
    expect(within(dialog).getByText('pass-new')).toBeInTheDocument();
    const issued = token.calls.find((c) => c.method === 'POST' && c.path === '/api/v1/passes');
    expect(issued?.body).toMatchObject({ mode: 'test', templateId: TEMPLATE.id, sendEmail: false });
  });

  it('says plainly that a sandbox cannot install yet, with no QR', async () => {
    kind = 'sandbox';
    mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Try on my phone' }));
    const dialog = await screen.findByRole('dialog', { name: 'Try on my phone' });
    expect(within(dialog).getByText(/isn't available yet/)).toBeInTheDocument();
    expect(within(dialog).queryByRole('img')).toBeNull();
  });
});
