import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProviders } from '../../../lib/providers.tsx';
import { createQueryClient } from '../../../lib/query-client.ts';
import '../../../lib/test-utils.tsx';
import { forgetStageMemory } from '../../../admin/templates/designer/scan/scan-stage-memory.ts';
import { builtPreviews } from '../../playground/test-data.ts';
import { AnonProvider } from './anon-context.tsx';
import { AnonDesign } from './anon-design.tsx';
import { useAnonValue } from './use-anon-value.ts';

const { data } = builtPreviews();
const PNG = new Uint8Array([137, 80, 78, 71]);

function Page() {
  const { value } = useAnonValue(data, false);
  return (
    <AnonProvider value={value}>
      <AnonDesign blueprint={value.blueprint} />
    </AnonProvider>
  );
}

function mount() {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const root = createRootRoute({ component: Page });
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

const seen: { url: string; init: RequestInit | undefined }[] = [];

beforeEach(() => {
  forgetStageMemory();
  sessionStorage.clear();
  history.replaceState(null, '', '/workbench/design');
  seen.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), init });
      return new Response(PNG, { headers: { 'content-type': 'image/png' } });
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

describe('Design signed out: a blueprint on the anonymous host', () => {
  it('offers the picker, Data, a disabled Design tab, Share and Save to my sandbox', async () => {
    mount();
    expect(await screen.findByRole('tab', { name: 'Data' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Design' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: /^Blueprint: / })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save to my sandbox' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Share as link' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: /Save version|Try on my phone/ })).toBeNull();
  });

  it('asks for nothing but the blueprint’s own files, and never with credentials', async () => {
    mount();
    await screen.findByRole('tab', { name: 'Data' });
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));
    for (const { url, init } of seen) {
      expect(url, url).toMatch(/^\/templates\//);
      expect(init?.credentials, url).toBe('omit');
    }
  });

  it('plans the card from the edited values in the browser, with no request', async () => {
    mount();
    const name = await screen.findByRole('textbox', { name: /^Name/ });
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));
    expect(await screen.findAllByText('Alex Morgan')).not.toHaveLength(0);
    const before = seen.length;
    await userEvent.clear(name);
    await userEvent.type(name, 'Casey River');
    await vi.waitFor(() => expect(screen.getAllByText('Casey River').length).toBeGreaterThan(0));
    expect(screen.queryByText('Alex Morgan')).toBeNull();
    for (const { url } of seen.slice(before)) expect(url, url).toMatch(/^\/templates\//);
    expect(seen.every((r) => !r.url.includes('/api/'))).toBe(true);
  });
});
