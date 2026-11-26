import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { json, renderApp } from '../../lib/test-utils.tsx';
import { forgetTokens } from '../host/token.ts';
import { setSingleKeys } from './prefs.ts';

const CONTEXTS = {
  sandbox: { orgId: 'sbx', name: 'dev-4f8c673e' },
  orgs: [
    {
      orgId: 'nw',
      name: 'Northwind',
      slug: 'nw',
      tools: ['design', 'passes', 'console', 'logs', 'events', 'inbox', 'activity', 'keys'],
    },
  ],
};

function handlers(summary: Record<string, unknown> = {}, contexts: unknown = CONTEXTS) {
  return {
    '/api/v1/workbench/contexts': () => json(contexts),
    '/api/v1/workbench/token': (_url: URL, init?: RequestInit) => {
      const { orgId } = JSON.parse(String(init?.body)) as { orgId: string };
      return json({
        token: `pbtry_${orgId}`,
        orgId,
        mode: 'test',
        expiresAt: Date.now() + 900_000,
        subject: 'member',
      });
    },
    '/api/v1/workbench/summary': () =>
      json({
        quickstart: null,
        errors: 0,
        failedDeliveries: 0,
        listening: false,
        inboxNew: 0,
        keysExpiring: 0,
        ...summary,
      }),
    '/api/v1/operations': () => json({ items: [] }),
  };
}

afterEach(() => {
  forgetTokens();
  setSingleKeys(true);
  localStorage.clear();
  sessionStorage.clear();
});

const nav = () => screen.getByRole('navigation', { name: 'Workbench' });

describe('WorkbenchShell', () => {
  it('a sandbox: its own mark, the grouped nav with all eleven areas, and the plain bar', async () => {
    const { container } = await renderApp('/workbench/o/sbx', {
      session: 'developer',
      handlers: handlers(),
    });
    await screen.findByRole('heading', { name: 'Home', level: 1 });
    expect(within(nav()).getAllByRole('link')).toHaveLength(11);
    expect(within(nav()).getByRole('link', { name: 'Logs' })).toHaveAttribute(
      'href',
      '/workbench/o/sbx/logs',
    );
    expect(within(nav()).getByRole('link', { name: 'Logs' })).toHaveAttribute(
      'aria-keyshortcuts',
      'g l',
    );
    expect(screen.getAllByRole('link', { name: 'Workbench' }).length).toBeGreaterThan(0);
    expect(
      screen.getByRole('button', { name: /^dev-4f8c673e Sandbox · Test, Switch context$/ }),
    ).toHaveTextContent('Sandbox · Test');
    expect(container.querySelector('[data-menubar]')).not.toHaveAttribute('data-tone');
    // One live region for the space: the shell's queue, not the SPA's route announcer.
    expect(container.querySelectorAll('[aria-live]')).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Skip to navigation' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Skip to tool' })).toBeInTheDocument();
  });

  it('an org Test: the Test-toned bar, and the nav drops Quickstart and Sandbox without reordering', async () => {
    const { container } = await renderApp('/workbench/o/nw/logs', {
      session: 'developer',
      handlers: handlers(),
    });
    await screen.findByRole('heading', { name: 'Logs', level: 1 });
    expect(container.querySelector('[data-menubar]')).toHaveAttribute('data-tone', 'test');
    const names = within(nav())
      .getAllByRole('link')
      .map((a) => a.textContent);
    expect(names).toEqual([
      'Home',
      'Design',
      'Passes',
      'Console',
      'Logs',
      'Events',
      'Inbox',
      'Activity',
      'Keys',
    ]);
    expect(within(nav()).getByRole('link', { name: 'Logs' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    // The router's prefix match would mark Home current too; the shell decides.
    expect(within(nav()).getByRole('link', { name: 'Home' })).not.toHaveAttribute('aria-current');
  });

  it('L13: tenant calls carry the bearer, omit the cookie and send no mode', async () => {
    const { fetchMock } = await renderApp('/workbench/o/nw', {
      session: 'developer',
      handlers: handlers(),
    });
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/workbench/summary'))).toBe(
        true,
      ),
    );
    const call = fetchMock.mock.calls.find(([u]) => String(u).includes('/workbench/summary'));
    const init = call?.[1] as RequestInit;
    expect(init.credentials).toBe('omit');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer pbtry_nw');
    expect(Object.keys(init.headers as object).some((h) => /mode/i.test(h))).toBe(false);
  });

  it('shows attention in the link names and on the area button', async () => {
    await renderApp('/workbench/o/sbx', {
      session: 'developer',
      handlers: handlers({
        errors: 3,
        listening: true,
        inboxNew: 2,
        quickstart: { done: 4, total: 5 },
      }),
    });
    await screen.findByRole('heading', { name: 'Home', level: 1 });
    await within(nav()).findByRole('link', { name: 'Logs, 3 new errors' });
    expect(within(nav()).getByRole('link', { name: 'Events, Listening' })).toBeInTheDocument();
    expect(within(nav()).getByRole('link', { name: 'Inbox, 2 new' })).toBeInTheDocument();
    expect(
      within(nav()).getByRole('link', { name: 'Quickstart, 4 of 5 done' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Home Test, change area. Attention in Logs' }),
    ).toHaveAttribute('aria-haspopup', 'dialog');
  });

  it('Mark seen sends the new mark as since[logs]', async () => {
    const { fetchMock } = await renderApp('/workbench/o/sbx/logs', {
      session: 'developer',
      handlers: handlers({ errors: 3 }),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Mark seen' }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => /since%5Blogs%5D=\d+/.test(String(u)))).toBe(true),
    );
  });

  it('g then a letter opens an area; the off-switch stops it and drops aria-keyshortcuts', async () => {
    const { router } = await renderApp('/workbench/o/sbx', {
      session: 'developer',
      handlers: handlers(),
    });
    await screen.findByRole('heading', { name: 'Home', level: 1 });
    fireEvent.keyDown(document.body, { key: 'g' });
    fireEvent.keyDown(document.body, { key: 'e' });
    await waitFor(() => expect(router.state.location.pathname).toBe('/workbench/o/sbx/events'));
    act(() => setSingleKeys(false));
    expect(within(nav()).getByRole('link', { name: 'Logs' })).not.toHaveAttribute(
      'aria-keyshortcuts',
    );
    fireEvent.keyDown(document.body, { key: 'g' });
    fireEvent.keyDown(document.body, { key: 'l' });
    await act(async () => {});
    expect(router.state.location.pathname).toBe('/workbench/o/sbx/events');
  });

  it('⌘K opens the palette with the areas, found by their keywords', async () => {
    await renderApp('/workbench/o/sbx', { session: 'developer', handlers: handlers() });
    await screen.findByRole('heading', { name: 'Home', level: 1 });
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    const input = await screen.findByPlaceholderText('Search tools, ids, docs');
    fireEvent.change(input, { target: { value: 'webhooks' } });
    expect(await screen.findByRole('option', { name: /Events/ })).toBeInTheDocument();
  });

  it('? opens the shortcuts sheet with the single-key switch', async () => {
    await renderApp('/workbench/o/sbx', { session: 'developer', handlers: handlers() });
    await screen.findByRole('heading', { name: 'Home', level: 1 });
    fireEvent.keyDown(document.body, { key: '?' });
    const sheet = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(within(sheet).getByRole('switch', { name: 'Single-key shortcuts' })).toBeChecked();
  });
});

describe('Workbench entry and states', () => {
  it('a context-free path lands in the sandbox, keeping its query and hash', async () => {
    const { router } = await renderApp('/workbench/logs?status=4xx#req_1', {
      session: 'developer',
      handlers: handlers(),
    });
    await screen.findByRole('heading', { name: 'Logs', level: 1 });
    expect(router.state.location.href).toBe('/workbench/o/sbx/logs?status=4xx#req_1');
  });

  it('a refused area says where it is not available and offers the nearest one', async () => {
    await renderApp('/workbench/o/nw/sandbox', { session: 'developer', handlers: handlers() });
    await screen.findByRole('heading', {
      name: "Not available in Northwind's Test mode",
      level: 1,
    });
    const main = screen.getByRole('main');
    expect(within(main).getByRole('link', { name: 'Go to Keys' })).toHaveAttribute(
      'href',
      '/workbench/o/nw/keys',
    );
    expect(within(main).getByRole('link', { name: 'Open in admin' })).toHaveAttribute(
      'href',
      '/admin/o/nw?mode=test',
    );
  });

  it('an unknown context is not in your Workbench', async () => {
    await renderApp('/workbench/o/other/logs', { session: 'developer', handlers: handlers() });
    await screen.findByRole('heading', { name: 'Not in your Workbench', level: 1 });
  });

  it('signed out: Design opens, everything else is the one sign-in state', async () => {
    await renderApp('/workbench/o/sbx/logs', { session: 'anon', handlers: handlers() });
    const title = await screen.findByRole('heading', {
      name: 'Sign in to use the Workbench',
      level: 1,
    });
    const main = title.closest('main') as HTMLElement;
    expect(screen.getAllByRole('link', { name: 'Sign in with Polaris ID' })).toHaveLength(1);
    expect(within(main).getByRole('link', { name: 'Sign in with Polaris ID' })).toHaveAttribute(
      'href',
      `/auth/oidc/start?next=${encodeURIComponent('/workbench/o/sbx/logs')}`,
    );
    expect(within(nav()).getByRole('link', { name: 'Design' })).toHaveAttribute(
      'href',
      '/workbench/design',
    );
  });

  it('signed out at /workbench/design: the Playground page', async () => {
    await renderApp('/workbench/design', { session: 'anon', handlers: handlers() });
    await screen.findByRole('heading', { name: 'Design', level: 1 });
    // The sidebar's card offers sign-in here; on the sign-in state it stays away (one buddy).
    expect(await screen.findByRole('link', { name: 'Sign in with Polaris ID' })).toHaveAttribute(
      'href',
      `/auth/oidc/start?next=${encodeURIComponent('/workbench/design')}`,
    );
  });

  it('an email-link session waits for Polaris ID', async () => {
    await renderApp('/workbench/o/sbx', {
      session: 'developer',
      amr: 'magic_link',
      handlers: handlers(),
    });
    await screen.findByRole('heading', { name: 'The Workbench needs Polaris ID.' });
  });

  it('no contexts: a developer is asked to make a sandbox, anyone else has no access', async () => {
    const none = { sandbox: null, orgs: [] };
    const first = await renderApp('/workbench', {
      session: 'developer',
      handlers: handlers({}, none),
    });
    await screen.findByRole('heading', { name: 'No sandbox yet', level: 1 });
    first.unmount();
    await renderApp('/workbench', { session: 'user', handlers: handlers({}, none) });
    await screen.findByRole('heading', { name: 'No Workbench access', level: 1 });
  });

  it('two orgs and none remembered: the chooser', async () => {
    const two = {
      sandbox: null,
      orgs: [
        { orgId: 'nw', name: 'Northwind', slug: 'nw', tools: ['logs'] },
        { orgId: 'ac', name: 'Acme', slug: 'ac', tools: ['logs'] },
      ],
    };
    await renderApp('/workbench', { session: 'user', handlers: handlers({}, two) });
    await screen.findByRole('heading', { name: 'Choose a context', level: 1 });
    expect(screen.getByRole('link', { name: /Acme/ })).toHaveAttribute('href', '/workbench/o/ac');
  });
});
