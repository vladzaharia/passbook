import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { ADMIN_NAV } from '../../lib/nav.ts';
import { json, renderApp } from '../../lib/test-utils.tsx';
import { THEME_KEY } from '../../lib/theme.tsx';

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  };
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  delete document.documentElement.dataset.theme;
});
afterEach(() => vi.unstubAllGlobals());

describe('route guards in the app', () => {
  it('sends signed-out visitors to /login with next', async () => {
    const { router } = await renderApp('/account?tab=emails', { session: 'anon' });
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(router.state.location.search).toEqual({ next: '/account?tab=emails' });
    expect(await screen.findByRole('heading', { name: 'Sign in', level: 1 })).toBeInTheDocument();
  });

  it('does not require a session for /login', async () => {
    const { router } = await renderApp('/login', { session: 'anon' });
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
  });

  it('sends signed-out visitors of /admin to /login', async () => {
    const { router } = await renderApp('/admin/passes', { session: 'anon' });
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(router.state.location.search).toEqual({ next: '/admin/passes' });
  });

  it('shows the forbidden page to a signed-in non-admin on /admin', async () => {
    const { container } = await renderApp('/admin', { session: 'user' });
    expect(
      await screen.findByRole('heading', { name: 'You do not have access', level: 1 }),
    ).toBeInTheDocument();
    expect(container.querySelector('[data-art]')).toHaveAttribute('data-art', 'lock');
    expect(screen.getByRole('button', { name: 'Sign in as someone else' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Admin' })).toBeNull();
  });

  it('lets a plain user into the portal and hides the Admin link', async () => {
    await renderApp('/account', { session: 'user' });
    expect(await screen.findByRole('heading', { name: 'Account', level: 1 })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Admin' })).toBeNull();
  });

  it('shows an Admin link to admins in the portal', async () => {
    await renderApp('/', { session: 'admin' });
    expect(await screen.findByRole('link', { name: 'Admin' })).toBeInTheDocument();
  });

  it('renders the holder not found page with the lost wallet', async () => {
    const { container } = await renderApp('/nope', { session: 'user' });
    expect(
      await screen.findByRole('heading', { name: 'Page not found', level: 1 }),
    ).toBeInTheDocument();
    const art = container.querySelector('[data-art]');
    expect(art).toHaveAttribute('data-art', 'wallet');
    expect(art).toHaveAttribute('data-state', 'lost');
  });

  it('renders the admin not found page with a palette search', async () => {
    const user = userEvent.setup();
    const { container } = await renderApp('/admin/nope', { session: 'admin' });
    expect(
      await screen.findByRole('heading', { name: 'Page not found', level: 1 }),
    ).toBeInTheDocument();
    expect(container.querySelector('main [data-art]')).toHaveAttribute('data-art', 'torn');
    expect(screen.getByRole('link', { name: 'Go to Overview' })).toBeInTheDocument();
    await user.click(within(screen.getByRole('main')).getByRole('button', { name: 'Search' }));
    expect(
      await screen.findByRole('combobox', { name: 'Search pages and passes' }),
    ).toBeInTheDocument();
  });

  it('shows a session fetch failure instead of the page', async () => {
    const { findByRole } = await renderApp('/', {
      handlers: { '/api/v1/session': () => new Response('boom', { status: 500 }) },
    });
    expect(await findByRole('alert')).toHaveTextContent('Server error. Try again.');
  });
});

describe('admin layout', () => {
  it('lists every IA section, marks the current one, and has no a11y violations', async () => {
    const { container } = await renderApp('/admin/passes', { session: 'admin' });
    const nav = await screen.findByRole('navigation', { name: 'Admin' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual(ADMIN_NAV.map((i) => i.label));
    expect(within(nav).getByRole('link', { name: 'Passes' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(nav).getByRole('link', { name: 'Overview' })).not.toHaveAttribute('aria-current');
    await screen.findByRole('heading', { name: 'Passes', level: 1 });
    expect((await axe(container)).violations).toEqual([]);
  });

  it('collapses the nav into a sheet via the menu button', async () => {
    const user = userEvent.setup();
    await renderApp('/admin', { session: 'admin' });
    await user.click(await screen.findByRole('button', { name: 'Menu' }));
    const sheet = await screen.findByRole('dialog', { name: 'Navigation' });
    await user.click(within(sheet).getByRole('link', { name: 'Users' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByRole('heading', { name: 'Users', level: 1 })).toBeInTheDocument();
  });

  it('opens the command palette with Ctrl+K and navigates', async () => {
    const user = userEvent.setup();
    const { router } = await renderApp('/admin', { session: 'admin' });
    await screen.findByRole('navigation', { name: 'Admin' });
    await user.keyboard('{Control>}k{/Control}');
    const input = await screen.findByRole('combobox', { name: 'Search pages and passes' });
    await user.type(input, 'audit');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/audit'));
  });

  it('searches passes from the palette after two characters and links to the result', async () => {
    const user = userEvent.setup();
    const seen: string[] = [];
    const { router } = await renderApp('/admin', {
      session: 'admin',
      handlers: {
        '/api/v1/passes': (url) => {
          seen.push(url.search);
          return json({
            items: [
              {
                id: 'p1',
                orgId: 'o1',
                templateId: 't1',
                templateVersion: '1',
                identityId: 'i1',
                serial: 'S-1',
                title: 'Ada Lovelace',
                subtitle: null,
                externalId: null,
                status: 'active',
                version: 1,
                connectionId: null,
                syncErrorCode: null,
                holderEmail: 'ada@example.com',
                holderState: 'owned',
                ownerUserId: null,
                modifiedAt: 1,
                createdAt: 1,
              },
            ],
            nextCursor: null,
          });
        },
      },
    });
    await screen.findByRole('navigation', { name: 'Admin' });
    await user.keyboard('{Control>}k{/Control}');
    const input = await screen.findByRole('combobox', { name: 'Search pages and passes' });
    await user.type(input, 'a');
    expect(seen).toEqual([]);
    await user.type(input, 'da');
    const option = await screen.findByRole('option', { name: /Ada Lovelace/ });
    expect(seen.at(-1)).toContain('q=ada');
    expect(screen.queryByText('No results')).toBeNull();
    await user.click(option);
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/passes/p1'));
  });

  it('moves focus to the new page heading and announces it on navigation', async () => {
    const user = userEvent.setup();
    await renderApp('/admin', { session: 'admin' });
    await user.click(await screen.findByRole('link', { name: 'Settings' }));
    const heading = await screen.findByRole('heading', { name: 'Settings', level: 1 });
    await waitFor(() => expect(heading).toHaveFocus());
    await waitFor(() =>
      expect(screen.getByRole('status', { name: '' })).toHaveTextContent('Settings'),
    );
  });

  it('skip link focuses main content', async () => {
    const user = userEvent.setup();
    await renderApp('/admin', { session: 'admin' });
    await screen.findByRole('navigation', { name: 'Admin' });
    await user.tab();
    expect(screen.getByRole('link', { name: 'Skip to content' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('main')).toHaveFocus();
  });

  it('lists orgs in the filter and keeps the choice', async () => {
    const user = userEvent.setup();
    await renderApp('/admin', {
      session: 'admin',
      handlers: {
        '/api/v1/orgs': () =>
          json({
            items: [
              {
                id: 'o1',
                name: 'Henrys',
                slug: 'henrys',
                status: 'active',
                defaultIdentityId: null,
                branding: {},
                createdAt: 1,
                updatedAt: 1,
                counts: { passes: 0, templates: 0, connections: 0, apiKeys: 0 },
                countsCapped: false,
              },
            ],
            nextCursor: null,
          }),
      },
    });
    const filter = await screen.findByRole('combobox', { name: /^Organization scope/ });
    expect(filter).toHaveTextContent('All orgs');
    await user.click(filter);
    await user.click(await screen.findByRole('option', { name: 'Henrys' }));
    expect(filter).toHaveTextContent('Henrys');
    expect(localStorage.getItem('wallet-org-filter')).toBe('o1');
  });
});

describe('theme', () => {
  const openMenu = async (user: ReturnType<typeof userEvent.setup>) =>
    user.click(await screen.findByRole('button', { name: 'Account menu' }));

  it('sets and clears data-theme from the admin account menu and persists the choice', async () => {
    const user = userEvent.setup();
    await renderApp('/admin', { session: 'admin' });
    await openMenu(user);
    await user.click(await screen.findByRole('menuitemradio', { name: 'Light' }));
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem(THEME_KEY)).toBe('light');
    // The menu stays open while choosing.
    await user.click(screen.getByRole('menuitemradio', { name: 'Dark' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    await user.click(screen.getByRole('menuitemradio', { name: 'System' }));
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(localStorage.getItem(THEME_KEY)).toBe('system');
  });

  it('applies the stored preference in the admin console only', async () => {
    localStorage.setItem(THEME_KEY, 'dark');
    const first = await renderApp('/admin', { session: 'admin' });
    await screen.findByRole('navigation', { name: 'Admin' });
    expect(document.documentElement.dataset.theme).toBe('dark');
    first.unmount();
    await renderApp('/account', { session: 'admin' });
    await screen.findByRole('heading', { name: 'Account', level: 1 });
    // Holder pages follow the system appearance and offer no toggle.
    await waitFor(() => expect(document.documentElement.dataset.theme).toBeUndefined());
    expect(screen.queryByRole('button', { name: 'Theme' })).toBeNull();
  });

  it('ignores a corrupt stored value', async () => {
    localStorage.setItem(THEME_KEY, 'neon');
    await renderApp('/admin', { session: 'admin' });
    await screen.findByRole('navigation', { name: 'Admin' });
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it('still switches when storage throws', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {},
    });
    await renderApp('/admin', { session: 'admin' });
    await openMenu(user);
    await user.click(await screen.findByRole('menuitemradio', { name: 'Dark' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('lists My passes, Account, Theme and Sign out in the admin account menu', async () => {
    const user = userEvent.setup();
    await renderApp('/admin', { session: 'admin' });
    await openMenu(user);
    const menu = await screen.findByRole('menu');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((i) => i.textContent),
    ).toEqual(['My passes', 'Account', 'Sign out']);
    expect(within(menu).getAllByRole('menuitemradio')).toHaveLength(3);
    expect(within(menu).getByText('Theme')).toBeInTheDocument();
  });
});

describe('user menu', () => {
  it('signs out with a POST that carries the CSRF token', async () => {
    const user = userEvent.setup();
    const { fetchMock } = await renderApp('/account', {
      session: 'user',
      handlers: { '/auth/logout': () => new Response(null, { status: 204 }) },
    });
    await user.click(await screen.findByRole('button', { name: 'Account menu' }));
    expect(await screen.findByText('test@example.com')).toBeInTheDocument();
    await user.click(await screen.findByRole('menuitem', { name: 'Sign out' }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => String(url) === '/auth/logout');
      expect(call).toBeTruthy();
      const init = call?.[1] as RequestInit;
      expect(init.method).toBe('POST');
      expect((init.headers as Record<string, string>)['x-csrf-token']).toBe('csrf-test');
    });
  });
});
