import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_NAV } from './nav.ts';
import { json, renderApp } from './test-utils.tsx';

const KEY = 'wallet-org-filter';

function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

const org = (id: string, name: string) => ({
  id,
  name,
  slug: id,
  status: 'active',
  defaultIdentityId: null,
  branding: {},
  createdAt: 1,
  updatedAt: 1,
  counts: { passes: 0, templates: 0, connections: 0, apiKeys: 0 },
  countsCapped: false,
});

const handlers = (seen: string[] = []) => ({
  '/api/v1/orgs': () =>
    json({ items: [org('o1', 'Northwind Climbing'), org('o2', 'Harbor')], nextCursor: null }),
  '/api/v1/passes': (url: URL) => {
    seen.push(url.searchParams.get('orgId') ?? 'all');
    return json({ items: [], nextCursor: null });
  },
});

beforeEach(() => vi.stubGlobal('localStorage', memoryStorage()));
afterEach(() => vi.unstubAllGlobals());

describe('org scope in the URL', () => {
  it('a link with ?orgId= shows that org, whatever this browser remembered', async () => {
    vi.stubGlobal('localStorage', memoryStorage({ [KEY]: 'o2' }));
    const seen: string[] = [];
    await renderApp('/admin/passes?orgId=o1', { session: 'admin', handlers: handlers(seen) });
    const scope = await screen.findByRole('combobox', { name: /^Organization scope/ });
    await waitFor(() => expect(scope).toHaveTextContent('Northwind Climbing'));
    expect(seen).not.toContain('o2');
    expect(seen.at(-1)).toBe('o1');
    expect(localStorage.getItem(KEY)).toBe('o1');
  });

  it('writes the remembered scope into a scoped URL that has none', async () => {
    vi.stubGlobal('localStorage', memoryStorage({ [KEY]: 'o2' }));
    const seen: string[] = [];
    const { router } = await renderApp('/admin/passes?status=active', {
      session: 'admin',
      handlers: handlers(seen),
    });
    await waitFor(() =>
      expect(router.state.location.search).toEqual({ status: 'active', orgId: 'o2' }),
    );
    expect(seen).toEqual(['o2']);
  });

  it('All organizations clears the URL and the remembered scope', async () => {
    vi.stubGlobal('localStorage', memoryStorage({ [KEY]: 'o1' }));
    const user = userEvent.setup();
    const { router } = await renderApp('/admin/passes?orgId=o1', {
      session: 'admin',
      handlers: handlers(),
    });
    const scope = await screen.findByRole('combobox', { name: /^Organization scope/ });
    await user.click(scope);
    await user.click(await screen.findByRole('option', { name: 'All organizations' }));
    await waitFor(() => expect(router.state.location.search).toEqual({}));
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(scope).toHaveTextContent('All organizations');
  });

  it('carries the scope to scoped pages and drops it on the rest', async () => {
    await renderApp('/admin/passes?orgId=o1', { session: 'admin', handlers: handlers() });
    const nav = await screen.findByRole('navigation', { name: 'Admin' });
    for (const item of ADMIN_NAV) {
      const href = within(nav).getByRole('link', { name: item.label }).getAttribute('href');
      expect(href).toBe(item.orgScoped ? `${item.to}?orgId=o1` : item.to);
    }
  });

  it('switches from the palette by writing the URL', async () => {
    const user = userEvent.setup();
    const { router } = await renderApp('/admin/passes', {
      session: 'admin',
      handlers: handlers(),
    });
    await screen.findByRole('navigation', { name: 'Admin' });
    await user.keyboard('{Control>}k{/Control}');
    await user.type(await screen.findByRole('combobox', { name: 'Search' }), 'switch');
    await user.click(await screen.findByRole('option', { name: /Switch organization/ }));
    await user.click(await screen.findByRole('option', { name: /Harbor/ }));
    await waitFor(() => expect(router.state.location.search).toEqual({ orgId: 'o2' }));
  });
});
