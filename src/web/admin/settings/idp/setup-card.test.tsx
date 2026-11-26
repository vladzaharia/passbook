import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { SETUP_ITEMS, type SetupItem } from '@/shared/contracts/idp-setup.ts';
import { json, renderApp } from '@/web/lib/test-utils.tsx';
import { fixtureOperation } from '@/web/ui/operation/fixtures.test-support.ts';

const status = {
  connected: true,
  mode: 'dry_run',
  frozen: false,
  keyExpiresAt: null,
  problems: [],
  budget: { snapshot: { day: 1, limit: 30 } },
  lastScimAt: null,
  drift: {},
  breakerOpen: false,
};
const settings = {
  items: [],
  oidc: {
    issuer: 'https://id.plrs.im',
    platformAdminGroup: [],
    platformAdminPinned: 0,
    adminGroup: [],
    developerGroup: [],
    userGroup: [],
    consoleGroupRequired: false,
  },
  released: { google: false, samsung: false },
};
const opOf = (id: string) =>
  fixtureOperation(
    {
      kind: 'idp.setup',
      title: 'Set up Polaris ID',
      doneTitle: 'Polaris ID set up',
      failTitle: 'Could not set up Polaris ID',
      steps: [{ key: 'check', label: 'Check Polaris ID', active: 'Reading the Polaris ID setup' }],
    },
    { status: 'running', at: 'check', id },
  );

/** Every item done but the ones the test overrides. */
const items = (over: Partial<Record<SetupItem['key'], Partial<SetupItem>>> = {}): SetupItem[] =>
  SETUP_ITEMS.map((key) => ({ key, status: 'done' as const, ...over[key] }));

const handlers = (
  list: SetupItem[],
  extra: Record<string, (u: URL, i?: RequestInit) => Response> = {},
) => ({
  '/api/v1/settings': () => json(settings),
  '/api/v1/platform/idp': () => json(status),
  '/api/v1/platform/idp/drift': () => json({ items: [], nextCursor: null }),
  '/api/v1/platform/idp/setup': () => json({ mode: 'dry_run', items: list }),
  '/api/v1/operations/op-preview': () => json(opOf('op-preview')),
  '/api/v1/operations/op-apply': () => json(opOf('op-apply')),
  '/api/v1/operations/op-rotate': () => json(opOf('op-rotate')),
  ...extra,
});

/** GET answers the matrix; POST records its body and starts the operation. */
const setupRoute =
  (list: SetupItem[], bodies: unknown[], opId: string) => (_u: URL, init?: RequestInit) => {
    if (init?.method !== 'POST') return json({ mode: 'dry_run', items: list });
    bodies.push(JSON.parse(String(init.body)));
    return json({ operation: opOf(opId) }, 202);
  };

const blockedList = items({
  client: { status: 'blocked', reason: 'client_not_found', owner: true },
  groups: { status: 'needed', reason: 'after:client' },
  write_mode: { note: 'dry_run' },
});

describe('Set up card', () => {
  // The page keeps its operation in `?op`, on the window: a run must not carry into the next test.
  beforeEach(() => window.history.replaceState(null, '', '/'));

  it('lists the 12 items with a reason, an after dependency and the owner runbook', async () => {
    const { container } = await renderApp('/admin/settings', {
      session: 'admin',
      handlers: handlers(blockedList),
    });
    const list = await screen.findByRole('list', { name: 'Set up' });
    expect(within(list).getAllByRole('listitem').length).toBeGreaterThanOrEqual(12);
    expect(within(list).getByText('PassBook app in Polaris ID')).toBeInTheDocument();
    expect(within(list).getByText('Sign in with Polaris ID once.')).toBeInTheDocument();
    expect(within(list).getByText('After PassBook app in Polaris ID.')).toBeInTheDocument();
    const link = within(list).getByRole('link', { name: 'Runbook for PassBook app in Polaris ID' });
    expect(link).toHaveAttribute(
      'href',
      expect.stringContaining('/docs/runbooks/go-live-polaris-id.md'),
    );
    expect(within(list).getByRole('link', { name: 'Runbook for Write mode' })).toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('shows an alias group as allowed', async () => {
    await renderApp('/admin/settings', {
      session: 'admin',
      handlers: handlers(
        items({
          client_groups: {
            rows: [
              { key: 'console', state: 'allowed' },
              { key: 'wallet_admins', state: 'allowed' },
            ],
          },
        }),
      ),
    });
    const detail = await screen.findByRole('list', { name: 'Allowed groups detail' });
    expect(within(detail).getByText('wallet_admins')).toBeInTheDocument();
    expect(within(detail).getAllByText('Allowed')).toHaveLength(2);
  });

  it('previews by default and applies only after a confirm', async () => {
    const bodies: unknown[] = [];
    const list = items({ client_restricted: { status: 'needed' } });
    await renderApp('/admin/settings', {
      session: 'admin',
      handlers: handlers(list, {
        '/api/v1/platform/idp/setup': setupRoute(list, bodies, 'op-preview'),
      }),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Preview' }));
    await waitFor(() => expect(bodies).toEqual([{ dryRun: true }]));
    expect((await screen.findAllByText(/Reading the Polaris ID setup/)).length).toBeGreaterThan(0);
  });

  it('asks before applying live', async () => {
    const bodies: unknown[] = [];
    const list = items({ client_restricted: { status: 'needed' } });
    await renderApp('/admin/settings', {
      session: 'admin',
      handlers: handlers(list, {
        '/api/v1/platform/idp/setup': setupRoute(list, bodies, 'op-apply'),
      }),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Apply' }));
    expect(bodies).toEqual([]);
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(bodies).toEqual([{ dryRun: false }]));
  });

  it('disables Apply while an item is blocked', async () => {
    await renderApp('/admin/settings', { session: 'admin', handlers: handlers(blockedList) });
    expect(await screen.findByRole('button', { name: 'Apply' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Preview' })).toBeEnabled();
  });

  it('rotates the SCIM token after a confirm', async () => {
    const bodies: unknown[] = [];
    await renderApp('/admin/settings', {
      session: 'admin',
      handlers: handlers(items(), {
        '/api/v1/platform/idp/scim-token/rotate': (_u, init) => {
          bodies.push(JSON.parse(String(init?.body)));
          return json({ operation: opOf('op-rotate') }, 202);
        },
      }),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'More' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Rotate SCIM token' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Rotate' }),
    );
    await waitFor(() => expect(bodies).toEqual([{ dryRun: false }]));
  });

  it('is hidden when Polaris ID cannot be reached', async () => {
    await renderApp('/admin/settings', {
      session: 'admin',
      handlers: handlers(items({ binding: { status: 'blocked', reason: 'binding_unreachable' } })),
    });
    await screen.findByRole('heading', { name: 'Polaris ID access' });
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Set up' })).toBeNull());
  });
});
