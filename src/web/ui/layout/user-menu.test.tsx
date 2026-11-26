import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { membershipFixture, renderApp } from '../../lib/test-utils.tsx';
import { THEME_COLOR, THEME_KEY } from '../../lib/theme.tsx';

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  };
}

const clearCookie = () => {
  // biome-ignore lint/suspicious/noDocumentCookie: resets the theme cookie between tests
  document.cookie = `${THEME_KEY}=; Path=/; Max-Age=0`;
};
const themeCookie = () => /(?:^|;\s*)wallet-theme=([^;]*)/.exec(document.cookie)?.[1];

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  clearCookie();
  delete document.documentElement.dataset.theme;
});
afterEach(() => {
  vi.unstubAllGlobals();
  clearCookie();
  for (const meta of document.head.querySelectorAll('meta[name="theme-color"]')) meta.remove();
});

const openMenu = async (user: ReturnType<typeof userEvent.setup>) => {
  // A click that lands as the lazy chunk swaps in is lost to the fallback button; click again until open.
  let menu: HTMLElement | null = null;
  await waitFor(async () => {
    menu = screen.queryByRole('menu');
    if (menu) return;
    await user.click(screen.getByRole('button', { name: 'Account menu' }));
    menu = await screen.findByRole('menu', {}, { timeout: 1500 });
  });
  return menu as unknown as HTMLElement;
};

const items = (menu: HTMLElement) =>
  within(menu)
    .getAllByRole('menuitem')
    .map((i) => i.textContent);

describe('account menu', () => {
  it('is one menu: identity, spaces, theme, Sign out; the console is checked', async () => {
    const user = userEvent.setup();
    await renderApp('/admin', { session: 'admin' });
    const menu = await openMenu(user);
    expect(items(menu)).toEqual([
      'My passes',
      'Account',
      'Admin',
      'Workbench',
      'Developers',
      'Sign out',
    ]);
    expect(within(menu).getByText('test@example.com')).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Admin' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(menu).getByRole('menuitem', { name: 'My passes' })).not.toHaveAttribute(
      'aria-current',
    );
    // Developers is another document: a plain link, a full page load.
    expect(within(menu).getByRole('menuitem', { name: 'Developers' })).toHaveAttribute(
      'href',
      '/developers',
    );
    expect(within(menu).getAllByRole('menuitemradio')).toHaveLength(3);
    expect(within(menu).getAllByRole('separator')).toHaveLength(3);
  });

  it('gives a holder the holder spaces and the theme', async () => {
    const user = userEvent.setup();
    await renderApp('/', { session: 'user' });
    const menu = await openMenu(user);
    expect(items(menu)).toEqual(['My passes', 'Account', 'Sign out']);
    expect(within(menu).getByRole('menuitem', { name: 'My passes' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(menu).getAllByRole('menuitemradio')).toHaveLength(3);
  });

  it('adds Admin for an organization member', async () => {
    const user = userEvent.setup();
    await renderApp('/', { session: 'user', memberships: [membershipFixture('o1')] });
    await waitFor(async () => {
      const menu = await openMenu(user);
      expect(items(menu)).toEqual(['My passes', 'Account', 'Admin', 'Workbench', 'Sign out']);
    });
  });

  it('gives an email-link session only the holder spaces', async () => {
    const user = userEvent.setup();
    await renderApp('/', {
      session: 'admin',
      amr: 'magic_link',
      memberships: [membershipFixture('o1')],
    });
    const menu = await openMenu(user);
    expect(items(menu)).toEqual(['My passes', 'Account', 'Sign out']);
  });

  it('gives a break-glass session Admin and not Developers', async () => {
    const user = userEvent.setup();
    await renderApp('/', { session: 'admin', amr: 'breakglass' });
    const menu = await openMenu(user);
    expect(items(menu)).toEqual(['My passes', 'Account', 'Admin', 'Sign out']);
  });

  it('offers Sign in in place of the avatar when signed out', async () => {
    await renderApp('/nope', { session: 'anon' });
    await screen.findByRole('heading', { name: 'Page not found', level: 1 });
    const links = await screen.findAllByRole('link', { name: 'Sign in' });
    const inBar = links.filter((l) => l.closest('[data-menubar]'));
    expect(inBar).toHaveLength(1);
    expect(inBar[0]).toHaveAttribute('href', '/login');
    expect(screen.queryByRole('button', { name: 'Account menu' })).toBeNull();
  });

  it('shows an email-link session Sign in with Polaris ID at the console, not the console', async () => {
    await renderApp('/admin', { session: 'admin', amr: 'magic_link' });
    expect(
      await screen.findByRole('heading', { name: 'Admin needs Polaris ID.', level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in with Polaris ID' })).toHaveAttribute(
      'href',
      '/auth/oidc/start?next=%2Fadmin%2Fplatform',
    );
    expect(screen.queryByRole('navigation', { name: 'Admin' })).toBeNull();
  });

  it('opens Account inside the console when opened from the console', async () => {
    const user = userEvent.setup();
    const { router } = await renderApp('/admin', { session: 'admin' });
    const menu = await openMenu(user);
    const account = within(menu).getByRole('menuitem', { name: 'Account' });
    expect(account).toHaveAttribute('href', '/admin/account');
    await user.click(account);
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/account'));
    expect(await screen.findByRole('heading', { name: 'Account', level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Admin' })).toBeInTheDocument();
    // Account sits outside a scope: the switcher offers one to open.
    expect(screen.getByRole('combobox', { name: 'Scope: Choose an organization' })).toBeVisible();
    const again = await openMenu(user);
    expect(within(again).getByRole('menuitem', { name: 'Account' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('opens Account in the portal from the portal', async () => {
    const user = userEvent.setup();
    await renderApp('/', { session: 'admin' });
    const menu = await openMenu(user);
    expect(within(menu).getByRole('menuitem', { name: 'Account' })).toHaveAttribute(
      'href',
      '/account',
    );
  });

  it('signs out with a POST that carries the CSRF token', async () => {
    const user = userEvent.setup();
    const { fetchMock } = await renderApp('/account', {
      session: 'user',
      handlers: { '/auth/logout': () => new Response(null, { status: 204 }) },
    });
    const menu = await openMenu(user);
    await user.click(within(menu).getByRole('menuitem', { name: 'Sign out' }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => String(url) === '/auth/logout');
      const init = call?.[1] as RequestInit;
      expect(init.method).toBe('POST');
      expect((init.headers as Record<string, string>)['x-csrf-token']).toBe('csrf-test');
    });
  });
});

describe('theme', () => {
  it('sets and clears data-theme and saves the choice in the cookie and storage', async () => {
    const user = userEvent.setup();
    await renderApp('/', { session: 'user' });
    await openMenu(user);
    await user.click(await screen.findByRole('menuitemradio', { name: 'Light' }));
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(themeCookie()).toBe('light');
    expect(localStorage.getItem(THEME_KEY)).toBe('light');
    // The menu stays open while choosing.
    await user.click(screen.getByRole('menuitemradio', { name: 'Dark' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    await user.click(screen.getByRole('menuitemradio', { name: 'System' }));
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(themeCookie()).toBe('system');
  });

  it.each(['/admin', '/account', '/login'])('applies the saved theme on %s', async (path) => {
    // biome-ignore lint/suspicious/noDocumentCookie: the saved choice
    document.cookie = `${THEME_KEY}=dark; Path=/`;
    await renderApp(path, { session: path === '/login' ? 'anon' : 'admin' });
    await screen.findByRole('heading', { level: 1 });
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('carries a choice stored before the cookie into the cookie', async () => {
    localStorage.setItem(THEME_KEY, 'light');
    await renderApp('/', { session: 'user' });
    await screen.findByRole('heading', { level: 1 });
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(themeCookie()).toBe('light');
  });

  it('colours the browser chrome with one theme-color for the theme on screen', async () => {
    for (const media of ['(prefers-color-scheme: light)', '(prefers-color-scheme: dark)']) {
      const meta = document.createElement('meta');
      meta.name = 'theme-color';
      meta.media = media;
      document.head.append(meta);
    }
    const user = userEvent.setup();
    await renderApp('/', { session: 'user' });
    await openMenu(user);
    await user.click(await screen.findByRole('menuitemradio', { name: 'Light' }));
    const metas = document.head.querySelectorAll('meta[name="theme-color"]');
    expect(metas).toHaveLength(1);
    expect(metas[0]).not.toHaveAttribute('media');
    expect(metas[0]).toHaveAttribute('content', THEME_COLOR.light);
    await user.click(screen.getByRole('menuitemradio', { name: 'Dark' }));
    expect(metas[0]).toHaveAttribute('content', THEME_COLOR.dark);
  });

  it('ignores a corrupt saved value', async () => {
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
    expect(themeCookie()).toBe('dark');
  });
});
