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
    // A fixed SaveBar's room sits at the end of the page, not inside the form that shows it.
    expect(main).toHaveClass('has-[[data-save-bar]]:pb-[calc(6rem+env(safe-area-inset-bottom))]');
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

  it('keeps the account menu on the forbidden page, with no space links in the bar', async () => {
    await renderApp('/admin', { session: 'user' });
    await screen.findByRole('heading', { name: 'You do not have access', level: 1 });
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Account menu' })).toBeInTheDocument();
  });

  it('is the same bar in the portal and the console: the mark, then the account menu', async () => {
    for (const [path, session] of [
      ['/account', 'user'],
      ['/admin', 'admin'],
    ] as const) {
      const { container, unmount } = await renderApp(path, { session });
      await screen.findByRole('button', { name: 'Account menu' });
      const bar = container.querySelector('[data-menubar]') as HTMLElement;
      expect(within(bar).queryByRole('link', { name: 'Admin' })).toBeNull();
      expect(within(bar).queryByRole('link', { name: 'My passes' })).toBeNull();
      expect(within(bar).getAllByRole('link', { name: 'PassBook' }).length).toBeGreaterThan(0);
      const buttons = within(bar).getAllByRole('button');
      expect(buttons.at(-1)).toHaveAccessibleName('Account menu');
      unmount();
    }
  });
});
