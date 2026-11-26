import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { json, membershipFixture, renderApp, sessionFixture } from '../../lib/test-utils.tsx';
import { readPref, THEME_KEY } from '../../lib/theme.tsx';
import { mountAccount } from './account.ts';

const clearSavedPasses = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../../lib/saved-passes.ts', () => ({ clearSavedPasses }));

const clearCookie = () => {
  // biome-ignore lint/suspicious/noDocumentCookie: resets the theme cookie between tests
  document.cookie = `${THEME_KEY}=; Path=/; Max-Age=0`;
};

let unmount: () => void = () => {};

/** Mounts the island over a Sign in link, as the prerendered bar has it. */
async function mount(session: ReturnType<typeof sessionFixture>, memberships: unknown[] = []) {
  const el = document.createElement('span');
  el.dataset.island = 'account';
  el.innerHTML = '<a href="/login">Sign in</a>';
  document.body.replaceChildren(el);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/v1/session') return json(session);
      if (url === '/api/v1/orgs/memberships/me') return json({ items: memberships });
      return new Response(null, { status: 404 });
    }),
  );
  unmount = await mountAccount(el);
  return el;
}

const items = (menu: HTMLElement) =>
  within(menu)
    .getAllByRole('menuitem')
    .map((i) => i.textContent);

beforeEach(() => {
  clearCookie();
  delete document.documentElement.dataset.theme;
});
afterEach(() => {
  unmount();
  unmount = () => {};
  vi.unstubAllGlobals();
  clearCookie();
  document.body.replaceChildren();
});

describe('the developer site account island', () => {
  it('keeps Sign in for a signed-out reader', async () => {
    const el = await mount(sessionFixture('anon'));
    expect(within(el).getByRole('link', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Account menu' })).toBeNull();
  });

  it('hydrates the SPA menu for a Polaris ID admin, Developers checked', async () => {
    const user = userEvent.setup();
    await mount(sessionFixture('admin'));
    await user.click(await screen.findByRole('button', { name: 'Account menu' }));
    const menu = await screen.findByRole('menu');
    expect(items(menu)).toEqual([
      'My passes',
      'Account',
      'Admin',
      'Workbench',
      'Developers',
      'Sign out',
    ]);
    expect(within(menu).getByRole('menuitem', { name: 'Developers' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(menu).getByRole('menuitem', { name: 'Admin' })).toHaveAttribute('href', '/admin');
    expect(within(menu).getByRole('menuitem', { name: 'My passes' })).toHaveAttribute('href', '/');
  });

  it('adds Admin for an organization member', async () => {
    const user = userEvent.setup();
    await mount(sessionFixture('user'), [{ revokedAt: null }]);
    await user.click(await screen.findByRole('button', { name: 'Account menu' }));
    expect(items(await screen.findByRole('menu'))).toEqual([
      'My passes',
      'Account',
      'Admin',
      'Workbench',
      'Sign out',
    ]);
  });

  it('shows the developer role Developers, checked', async () => {
    const user = userEvent.setup();
    await mount(sessionFixture('developer'));
    await user.click(await screen.findByRole('button', { name: 'Account menu' }));
    const menu = await screen.findByRole('menu');
    expect(items(menu)).toEqual(['My passes', 'Account', 'Workbench', 'Developers', 'Sign out']);
    expect(within(menu).getByRole('menuitem', { name: 'Developers' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('shows an email-link session the holder spaces and the way in through Polaris ID', async () => {
    const user = userEvent.setup();
    await mount(sessionFixture('admin', 'magic_link'));
    expect(await screen.findByRole('link', { name: 'Sign in with Polaris ID' })).toHaveAttribute(
      'href',
      '/auth/oidc/start?next=%2Fdevelopers',
    );
    await user.click(screen.getByRole('button', { name: 'Account menu' }));
    expect(items(await screen.findByRole('menu'))).toEqual(['My passes', 'Account', 'Sign out']);
  });

  it("clears this phone's saved passes when it signs out", async () => {
    const user = userEvent.setup();
    await mount(sessionFixture('user'));
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async (url: string) =>
      url === '/auth/logout' ? json({ redirect: '/login' }) : json(sessionFixture('user')),
    );
    await user.click(await screen.findByRole('button', { name: 'Account menu' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Sign out' }));
    await waitFor(() => expect(clearSavedPasses).toHaveBeenCalled());
  });

  it('keeps the theme chosen here when the portal opens', async () => {
    const user = userEvent.setup();
    await mount(sessionFixture('user'));
    await user.click(await screen.findByRole('button', { name: 'Account menu' }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'Dark' }));
    expect(readPref()).toBe('dark');
    unmount();
    document.body.replaceChildren();
    delete document.documentElement.dataset.theme;
    vi.unstubAllGlobals();
    // The SPA reads the same cookie.
    await renderApp('/', { session: 'user', memberships: [membershipFixture('o1')] });
    await screen.findByRole('heading', { level: 1 });
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'));
  });
});
