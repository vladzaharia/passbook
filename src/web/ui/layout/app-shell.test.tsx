import { onlineManager } from '@tanstack/react-query';
import { act, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_ID } from '../../lib/route-focus.tsx';
import { renderApp } from '../../lib/test-utils.tsx';

afterEach(() => act(() => onlineManager.setOnline(true)));

const SHELLS = [
  { name: 'admin', path: '/admin', session: 'admin', heading: 'Overview', holder: false },
  { name: 'portal', path: '/account', session: 'user', heading: 'Account', holder: true },
  { name: 'bare (/login)', path: '/login', session: 'anon', heading: 'Sign in', holder: true },
  {
    name: 'standalone error',
    path: '/admin',
    session: 'user',
    heading: 'You do not have access',
    holder: true,
  },
] as const;

describe('AppShell', () => {
  it.each(SHELLS)('$name: one frame, the offline bar under the top bar', async (shell) => {
    const { container } = await renderApp(shell.path, { session: shell.session });
    await screen.findByRole('heading', { name: shell.heading, level: 1 });
    const main = screen.getByRole('main');
    expect(main).toHaveAttribute('id', MAIN_ID);
    expect(main).toHaveClass('px-safe', 'pb-[max(1.5rem,env(safe-area-inset-bottom))]');
    const frame = container.querySelector('.min-h-dvh') as HTMLElement;
    expect(frame).toHaveClass('[--wl-gutter:1rem]', 'sm:[--wl-gutter:1.5rem]');
    expect(container.querySelector('.wl-portal') !== null).toBe(shell.holder);

    act(() => onlineManager.setOnline(false));
    const banner = screen.getByText('Offline').closest('.wl-offline') as HTMLElement;
    const sticky = banner.parentElement as HTMLElement;
    // In flow inside the sticky block, after the bar: it sticks with the bar and pushes main down.
    expect(banner).not.toHaveClass('fixed');
    expect(sticky).toHaveClass('sticky', 'top-0');
    expect(sticky.nextElementSibling).toBe(main);
    if (shell.name !== 'bare (/login)') {
      expect(banner.previousElementSibling?.tagName).toBe('HEADER');
    }
  });

  it('gives the top bar 56 px with its border, on the page surface', async () => {
    const { container } = await renderApp('/', { session: 'user' });
    await screen.findByRole('heading', { name: 'My passes', level: 1 });
    const header = container.querySelector('header.border-b') as HTMLElement;
    expect(header).toHaveClass('bg-surface-page', 'pt-[env(safe-area-inset-top)]');
    expect(header.firstElementChild).toHaveClass('h-[calc(3.5rem-1px)]', 'px-safe');
  });

  it('keeps the account menu and nav on the forbidden page', async () => {
    await renderApp('/admin', { session: 'user' });
    await screen.findByRole('heading', { name: 'You do not have access', level: 1 });
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(
      within(nav)
        .getAllByRole('link')
        .map((l) => l.textContent),
    ).toEqual(['My passes', 'Account']);
    expect(screen.getByRole('button', { name: 'Account menu' })).toBeInTheDocument();
  });

  it('marks the current portal page, Admin included in the same nav', async () => {
    await renderApp('/account', { session: 'admin' });
    await screen.findByRole('heading', { name: 'Account', level: 1 });
    const nav = screen.getByRole('navigation', { name: 'Main' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual(['My passes', 'Account', 'Admin']);
    expect(within(nav).getByRole('link', { name: 'Account' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    // One link style, 36 px like the admin sidebar; only Admin hides on phones.
    for (const link of links) expect(link).toHaveClass('min-h-9');
    expect(links.filter((l) => l.classList.contains('max-sm:hidden'))).toEqual([links[2]]);
  });
});
