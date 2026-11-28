import type { QueryClient } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { problem, renderApp } from '../../lib/test-utils.tsx';
import { markSessionGone } from '../host/session-gone.ts';
import { forgetTokens } from '../host/token.ts';
import { setSingleKeys } from './prefs.ts';
import { handlers } from './test-fixtures.ts';

const TWO = {
  sandbox: null,
  orgs: [
    { orgId: 'nw', name: 'Northwind', slug: 'nw', tools: ['console', 'logs'] },
    { orgId: 'ac', name: 'Acme', slug: 'ac', tools: ['console', 'logs', 'design'] },
  ],
};

afterEach(() => {
  forgetTokens();
  setSingleKeys(true);
  localStorage.clear();
  sessionStorage.clear();
});

const nav = () => screen.getByRole('navigation', { name: 'Workbench' });
const findNav = () => screen.findByRole('navigation', { name: 'Workbench' });

describe('a context change (R4 M1)', () => {
  it('chooser to an org keeps the shell, moves focus to the tool heading and announces it', async () => {
    const { container } = await renderApp('/workbench', {
      session: 'user',
      handlers: handlers({}, TWO),
    });
    await screen.findByRole('heading', { name: 'Choose a context', level: 1 });
    const bar = container.querySelector('[data-menubar]');
    const region = container.querySelector('[data-wb-announcer]');
    expect(bar).not.toBeNull();
    fireEvent.click(screen.getByRole('link', { name: /Acme/ }));
    const heading = await screen.findByRole('heading', { name: 'Home', level: 1 });
    // The same nodes: the shell did not remount, so nothing was lost and the announcer lived on.
    expect(container.querySelector('[data-menubar]')).toBe(bar);
    expect(container.querySelector('[data-wb-announcer]')).toBe(region);
    await waitFor(() => expect(document.activeElement).toBe(heading));
    await waitFor(() => expect(region?.textContent).toContain('Now in Acme, Test'));
  });

  it('org to org does the same through the one announcer', async () => {
    const { container } = await renderApp('/workbench/o/nw/logs', {
      session: 'user',
      handlers: handlers({}, TWO),
    });
    await screen.findByRole('heading', { name: 'Logs', level: 1 });
    const bar = container.querySelector('[data-menubar]');
    await userEvent.click(await screen.findByRole('button', { name: /Switch context$/ }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /Acme/ }));
    await waitFor(() =>
      expect(container.querySelector('[data-wb-announcer]')?.textContent).toContain(
        'Now in Acme, Test',
      ),
    );
    expect(container.querySelector('[data-menubar]')).toBe(bar);
    expect(container.querySelectorAll('[data-wb-announcer]')).toHaveLength(1);
  });
});

describe('a failed refresh of the contexts (R4 M2)', () => {
  const refetch = (client: QueryClient) =>
    act(async () => {
      await client.refetchQueries({ queryKey: ['workbench', 'contexts'] });
    });

  it('keeps the open tool and says so, with Retry', async () => {
    let fail = false;
    const base = handlers();
    const { queryClient } = await renderApp('/workbench/o/nw/logs', {
      session: 'developer',
      handlers: {
        ...base,
        '/api/v1/workbench/contexts': () =>
          fail ? problem(500, 'server', 'Down.') : base['/api/v1/workbench/contexts'](),
      },
    });
    await screen.findByRole('heading', { name: 'Logs', level: 1 });
    fail = true;
    await refetch(queryClient);
    expect(await screen.findByText('Could not refresh your contexts.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Logs', level: 1 })).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() =>
      expect(screen.queryByText('Could not refresh your contexts.')).not.toBeInTheDocument(),
    );
  });

  it('a 401 is the Sign in again banner on the kept page, never Retry', async () => {
    let fail = false;
    const base = handlers();
    const { queryClient } = await renderApp('/workbench/o/nw/logs', {
      session: 'developer',
      handlers: {
        ...base,
        '/api/v1/workbench/contexts': () =>
          fail ? problem(401, 'unauthenticated', 'Sign in.') : base['/api/v1/workbench/contexts'](),
      },
    });
    await screen.findByRole('heading', { name: 'Logs', level: 1 });
    fail = true;
    await refetch(queryClient);
    expect(await screen.findByText('Your session ended')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Logs', level: 1 })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    // L13: signed in again elsewhere, the next good answer clears the banner.
    fail = false;
    await refetch(queryClient);
    await waitFor(() => expect(screen.queryByText('Your session ended')).not.toBeInTheDocument());
  });
});

describe('the chooser (R4 M4)', () => {
  it('keeps the tool, the query and the hash through to the chosen context', async () => {
    const { router } = await renderApp('/workbench/console?op=passes.create#step-2', {
      session: 'user',
      handlers: handlers({}, TWO),
    });
    await screen.findByRole('heading', { name: 'Choose a context', level: 1 });
    expect(screen.getByRole('link', { name: /Acme/ })).toHaveAttribute(
      'href',
      '/workbench/o/ac/console?op=passes.create#step-2',
    );
    fireEvent.click(screen.getByRole('link', { name: /Acme/ }));
    await waitFor(() =>
      expect(router.state.location.href).toBe('/workbench/o/ac/console?op=passes.create#step-2'),
    );
  });

  it('a tool the chosen context lacks lands on its Home', async () => {
    await renderApp('/workbench/design', { session: 'user', handlers: handlers({}, TWO) });
    await screen.findByRole('heading', { name: 'Choose a context', level: 1 });
    expect(screen.getByRole('link', { name: /Northwind/ })).toHaveAttribute(
      'href',
      '/workbench/o/nw',
    );
    expect(screen.getByRole('link', { name: /Acme/ })).toHaveAttribute(
      'href',
      '/workbench/o/ac/design',
    );
  });
});

describe('the nav and the bar', () => {
  it('L5: signed out, only Design and Quickstart link and the bar offers no second Sign in', async () => {
    await renderApp('/workbench/o/sbx/logs', { session: 'anon', handlers: handlers() });
    await screen.findByRole('heading', { name: 'Sign in to use the Workbench', level: 1 });
    expect(
      within(await findNav())
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['Quickstart', 'Design']);
    expect(within(nav()).getByText('Logs')).not.toHaveAttribute('href');
    expect(screen.queryByRole('link', { name: 'Sign in' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /^Sign in/ })).toHaveLength(1);
  });

  it('N1: signed out on Design, a visible Sign in stays in the bar below 1024', async () => {
    await renderApp('/workbench/design', { session: 'anon', handlers: handlers() });
    const signIn = await screen.findByRole('link', { name: 'Sign in' });
    expect(signIn.closest('.lg\\:hidden')).not.toBeNull();
  });

  it('L2: Mark seen waits for the server time', async () => {
    await renderApp('/workbench/o/sbx/logs', {
      session: 'developer',
      handlers: handlers({ errors: 3, now: undefined }),
    });
    await screen.findByRole('heading', { name: 'Logs', level: 1 });
    await within(await findNav()).findByRole('link', { name: 'Logs, 3 new errors' });
    expect(screen.queryByRole('button', { name: 'Mark seen' })).not.toBeInTheDocument();
  });

  it('L1: a Mark seen keeps the other counts showing while the summary reloads', async () => {
    let calls = 0;
    const base = handlers({ errors: 3, inboxNew: 2 });
    await renderApp('/workbench/o/sbx/logs', {
      session: 'developer',
      handlers: {
        ...base,
        '/api/v1/workbench/summary': () =>
          ++calls === 1
            ? base['/api/v1/workbench/summary']()
            : new Promise<Response>(() => undefined),
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Mark seen' }));
    await waitFor(() => expect(calls).toBe(2));
    expect(within(nav()).getByRole('link', { name: 'Inbox, 2 new' })).toBeInTheDocument();
  });

  it('L9 and L10: the area button ends in its chevron after the Test tag; Docs leaves the bar on phones only', async () => {
    await renderApp('/workbench/o/sbx/logs', { session: 'developer', handlers: handlers() });
    const button = await screen.findByRole('button', { name: /^Logs Test, change area/ });
    const tag = within(button).getByText('Test');
    const chevron = button.lastElementChild as Element;
    expect(chevron.tagName.toLowerCase()).toBe('svg');
    expect(tag.compareDocumentPosition(chevron) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    const docs = screen.getAllByRole('link', { name: 'Docs' })[0] as HTMLElement;
    expect(docs.className).toContain('max-sm:hidden');
    expect(docs.className).not.toContain('max-lg:hidden');
  });

  it('L14: an attention count ticks with CountUp', async () => {
    const { container } = await renderApp('/workbench/o/sbx/logs', {
      session: 'developer',
      handlers: handlers({ errors: 3 }),
    });
    await screen.findByRole('heading', { name: 'Logs', level: 1 });
    await within(await findNav()).findByRole('link', { name: 'Logs, 3 new errors' });
    expect(container.querySelector('.wb-meta[data-kind="danger"] .tabular-nums')).toHaveTextContent(
      '3',
    );
  });
});

describe('the session banner', () => {
  it('shows on the kept page when the session is marked gone', async () => {
    await renderApp('/workbench/o/sbx/logs', { session: 'developer', handlers: handlers() });
    await screen.findByRole('heading', { name: 'Logs', level: 1 });
    act(() => markSessionGone());
    expect(await screen.findByText('Your session ended')).toBeInTheDocument();
  });
});
