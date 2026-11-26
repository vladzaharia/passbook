import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WB_DESIGN } from '@/shared/copy/workbench-design.ts';
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
import { ApiError } from '../../lib/errors.ts';
import { AppProviders } from '../../lib/providers.tsx';
import { createQueryClient } from '../../lib/query-client.ts';
import '../../lib/test-utils.tsx';
import type { ToolApi } from '../../lib/tool-api.tsx';
import { DESIGN_EXTRAS } from './extras.tsx';
import { TemplateProvider } from './template-context.tsx';

vi.mock('../host/tool-host.tsx', () => ({
  useOptionalToolHost: () => ({ context: { kind: 'org', orgId: 'org-wb' } }),
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

/** The Stamp card: its art and every strip it draws are files of the version. */
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

const answers: Record<string, unknown> = {
  '/pass-setup': {
    brand: {
      logo: { source: 'org', value: { sha: SHA } },
      icon: { source: 'org', value: { sha: SHA } },
      passColors: { source: 'template', value: null },
    },
  },
  '/workspace': { name: 'Northwind', branding: { accent: null, logo: { sha: SHA } } },
};

function client(): WorkbenchClient {
  const answer = async (path: string, ...rest: unknown[]) => {
    if (path.endsWith('/versions') && rest.length > 1)
      return { report: { ok: true, issues: [] }, passJson: DOC.passJson, assets: [] };
    const hit = Object.keys(answers).find((tail) => path.endsWith(tail));
    if (hit) return answers[hit];
    if (path === '/api/v1/settings' || path === '/api/v1/scan-zones') return { items: [] };
    throw new ApiError({ status: 404, code: 'not_found', detail: 'Not found.' });
  };
  const api = {
    get: answer,
    post: answer,
    put: answer,
    patch: answer,
    deleteJson: answer,
    delete: answer,
    action: answer,
  } as unknown as ToolApi;
  return { kind: 'workbench-token', api, token: async () => 'tok' };
}

function Mounted({ token }: { token: WorkbenchClient }) {
  const host = useWorkbenchDesignerHost({
    orgId: ORG,
    orgName: 'Northwind',
    client: token,
    extras: DESIGN_EXTRAS,
  });
  return (
    <DesignerHostProvider host={host}>
      <TemplateProvider value={{ id: TEMPLATE.id, name: TEMPLATE.name }}>
        <Designer
          template={TEMPLATE}
          draftKey="wb-keep"
          base={{ version: 'v1', doc: DOC }}
          draft={null}
          assetBase={(v) => `/api/v1/templates/${TEMPLATE.id}/versions/${v}/assets?orgId=${ORG}`}
        />
      </TemplateProvider>
    </DesignerHostProvider>
  );
}

/** A matchMedia that answers width queries for a window the test resizes. */
function windowOf(initial: number) {
  let width = initial;
  const listeners = new Set<() => void>();
  const test = (query: string) => {
    const max = /max-width:\s*([\d.]+)px/.exec(query);
    const min = /min-width:\s*([\d.]+)px/.exec(query);
    if (max) return width <= Number(max[1]);
    if (min) return width >= Number(min[1]);
    return false;
  };
  vi.stubGlobal('matchMedia', (query: string) => ({
    media: query,
    get matches() {
      return test(query);
    },
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  }));
  return (next: number) => {
    width = next;
    act(() => {
      for (const fn of listeners) fn();
    });
  };
}

let made = 0;
const network = vi.fn(async (input: RequestInfo | URL) => {
  const path = new URL(String(input), 'http://localhost').pathname;
  return path.includes('/assets/') || path.includes('/branding/')
    ? new Response(PNG, { headers: { 'content-type': 'image/png' } })
    : new Response(null, { status: 404 });
});

beforeEach(() => {
  forgetStageMemory();
  network.mockClear();
  vi.stubGlobal('fetch', network);
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

/** The first control of the Data tab's form. */
const firstSample = () =>
  within(screen.getByRole('tabpanel', { name: WB_DESIGN.tabs.data })).getAllByRole(
    'textbox',
  )[0] as HTMLInputElement;

function open() {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const token = client();
  const root = createRootRoute({ component: () => <Mounted token={token} /> });
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

describe('the Workbench designer across the phone breakpoint', () => {
  it('keeps the draft, the open panel and half-typed JSON when the layout swaps and comes back', async () => {
    const resize = windowOf(1440);
    open();
    const user = userEvent.setup();
    await screen.findByRole('tab', { name: WB_DESIGN.tabs.data });

    // A saved-looking change, a JSON edit in progress and the Design tab open.
    const name = firstSample();
    await user.clear(name);
    await user.type(name, 'Casey River');
    await user.click(screen.getByRole('button', { name: new RegExp(WB_DESIGN.json) }));
    const json = await screen.findByLabelText(WB_DESIGN.jsonInput);
    fireEvent.change(json, { target: { value: '{ "holder": ' } });
    await user.click(screen.getByRole('tab', { name: WB_DESIGN.tabs.design }));
    expect(screen.getByRole('tab', { name: WB_DESIGN.tabs.design })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await user.click(screen.getByRole('tab', { name: WB_DESIGN.tabs.data }));
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();

    // Phone width swaps the structure and the card for another tree; a wide window brings the first back.
    resize(390);
    await waitFor(() => expect(screen.queryByTestId('designer-layout')).not.toBeInTheDocument());
    resize(1440);
    await screen.findByTestId('designer-layout');

    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: WB_DESIGN.tabs.data })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(await screen.findByLabelText(WB_DESIGN.jsonInput)).toHaveValue('{ "holder": ');
    await user.click(screen.getByRole('button', { name: new RegExp(WB_DESIGN.json) }));
    const form = firstSample();
    expect(form.value).toBe('Casey River');
  });

  it('keeps the open Design tab through the same swap', async () => {
    const resize = windowOf(1440);
    open();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: WB_DESIGN.tabs.design }));
    resize(390);
    await waitFor(() => expect(screen.queryByTestId('designer-layout')).not.toBeInTheDocument());
    resize(1440);
    await screen.findByTestId('designer-layout');
    expect(screen.getByRole('tab', { name: WB_DESIGN.tabs.design })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });
});

describe('the Stamp card on the Workbench token', () => {
  it('asks for each file once', async () => {
    windowOf(1440);
    open();
    await screen.findByRole('tab', { name: WB_DESIGN.tabs.data });
    await waitFor(() => expect(network.mock.calls.length).toBeGreaterThan(3));
    // Let the images list, the card and the strip preview all settle, then edit: every edit renews them.
    await new Promise((r) => setTimeout(r, 300));
    const user = userEvent.setup();
    const name = firstSample();
    await user.type(name, ' Jr');
    await new Promise((r) => setTimeout(r, 300));
    const paths = network.mock.calls.map(([input]) => String(input));
    expect(new Set(paths).size).toBe(paths.length);
    // RL_API_TRY allows 60 calls a minute for the whole session.
    expect(paths.length).toBeLessThan(60);
  });
});
