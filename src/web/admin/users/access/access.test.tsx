import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { json, renderApp } from '@/web/lib/test-utils.tsx';

const NOW = 1_700_000_000_000;
const detail = {
  id: 'u2',
  name: 'Ada Lovelace',
  primaryEmail: 'ada@example.com',
  status: 'active',
  lastRoles: ['user'],
  createdAt: NOW,
  lastLoginAt: NOW,
  passCount: 0,
  signInMethods: ['oidc'],
  emails: [{ email: 'ada@example.com', verifiedVia: 'oidc', verifiedAt: NOW }],
  identities: [],
  sessions: [],
  passes: [],
  recentAudit: [],
};
const role = (name: string, over: Record<string, unknown> = {}) => ({
  role: name,
  wanted: false,
  present: false,
  presence: 'none',
  held: false,
  memberships: [],
  sponsorships: [],
  grantedAt: null,
  error: null,
  ...over,
});
const access = (over: Record<string, unknown> = {}) => ({
  userId: 'u2',
  connected: true,
  platformAdmin: false,
  disabled: false,
  linked: true,
  account: { class: 'created', disabledInIdp: false },
  roles: [
    role('console', {
      wanted: true,
      present: true,
      memberships: [{ org: { id: 'o1', name: 'Acme' } }],
    }),
    role('developer'),
    role('support'),
  ],
  ...over,
});
const operation = (over: Record<string, unknown> = {}) => ({
  id: 'op1',
  kind: 'idp.restore',
  title: 'Restoring access',
  text: 'Restoring access',
  status: 'running',
  orgId: null,
  mode: null,
  target: { type: 'user', id: 'u2' },
  step: null,
  steps: [],
  attempt: 1,
  cancelable: false,
  cancelRequested: false,
  startedBy: { type: 'user', id: 'u1' },
  createdAt: NOW,
  startedAt: NOW,
  updatedAt: NOW,
  finishedAt: null,
  error: null,
  result: null,
  revision: 1,
  pollAfterMs: 1000,
  ...over,
});

const base = {
  '/api/v1/users/u2': () => json(detail),
  '/api/v1/settings': () => json({ items: [], oidc: {} }),
  '/api/v1/platform/idp/groups': () => json({ items: [], nextCursor: null }),
  '/api/v1/users/u2/claims': () => json({ claims: {}, otherKeys: 0 }),
};
const open = (
  handlers: Record<string, (url: URL, init?: RequestInit) => Response | Promise<Response>>,
) => renderApp('/admin/users/u2', { session: 'admin', handlers: { ...base, ...handlers } });

describe('user Access card', () => {
  it('shows the roles with why, and has no axe violations', async () => {
    const { container } = await open({ '/api/v1/users/u2/access': () => json(access()) });
    const card = (await screen.findByRole('heading', { name: 'Polaris ID access' })).closest(
      'div.relative',
    ) as HTMLElement;
    expect(within(card).getByText('Created by PassBook')).toBeInTheDocument();
    expect(within(card).getByText('From 1 membership')).toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('hides every Polaris ID surface while the binding is absent', async () => {
    await open({ '/api/v1/users/u2/access': () => json(access({ connected: false })) });
    expect(await screen.findByRole('heading', { name: 'Ada Lovelace' })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Polaris ID access')).toBeNull());
    expect(screen.queryByRole('heading', { name: 'Claims' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Offboard' })).toBeNull();
  });

  it('restores a paused role after a confirm and shows the operation', async () => {
    const calls: string[] = [];
    await open({
      '/api/v1/users/u2/access': () =>
        json(
          access({
            roles: [
              role('console', { held: true, presence: 'passbook' }),
              role('developer'),
              role('support'),
            ],
          }),
        ),
      '/api/v1/users/u2/holds/console': (_u, init) => {
        calls.push(String(init?.method));
        return json({ operation: operation() }, 202);
      },
      '/api/v1/operations/op1': () => json(operation()),
    });
    const ui = userEvent.setup();
    expect(await screen.findByText('Access paused')).toBeInTheDocument();
    await ui.click(screen.getByRole('button', { name: 'Restore' }));
    const dialog = await screen.findByRole('alertdialog');
    await ui.click(within(dialog).getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(calls).toEqual(['DELETE']));
    expect(await screen.findByRole('region', { name: 'Restoring access' })).toBeInTheDocument();
  });

  it('grants developer access', async () => {
    const bodies: unknown[] = [];
    await open({
      '/api/v1/users/u2/access': () => json(access()),
      '/api/v1/users/u2/roles': (_u, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return json(access());
      },
    });
    const ui = userEvent.setup();
    await screen.findByText('Polaris ID access');
    const row = screen.getByText('Developer', { selector: 'span' }).closest('li') as HTMLElement;
    await ui.click(within(row).getByRole('button', { name: 'Grant' }));
    await waitFor(() => expect(bodies).toEqual([{ role: 'developer', grant: true }]));
  });
});

describe('Offboard', () => {
  const plan = (over: Record<string, unknown> = {}) => ({
    userId: 'u2',
    memberships: [{ org: { id: 'o1', name: 'Acme' }, membershipId: 'm1' }],
    kept: [],
    sponsorships: [],
    grants: [],
    personalKeys: 0,
    platformKeys: [],
    sessions: 2,
    sandboxOrgId: null,
    removes: ['console'],
    external: [],
    blockers: [],
    ...over,
  });

  it('reads the dry-run plan, then needs the name typed, then starts the operation', async () => {
    const posts: unknown[] = [];
    await open({
      '/api/v1/users/u2/access': () => json(access()),
      '/api/v1/users/u2/offboard': (_u, init) => {
        const body = JSON.parse(String(init?.body));
        posts.push(body);
        return body.dryRun
          ? json({ plan: plan(), operation: null })
          : json(
              {
                plan: plan(),
                operation: operation({ kind: 'idp.offboard', title: 'Offboarding' }),
              },
              202,
            );
      },
      '/api/v1/operations/op1': () =>
        json(operation({ kind: 'idp.offboard', title: 'Offboarding' })),
    });
    const ui = userEvent.setup();
    await ui.click(await screen.findByRole('button', { name: 'Offboard' }));
    const dialog = await screen.findByRole('dialog', { name: 'Offboard Ada Lovelace?' });
    expect(await within(dialog).findByText(/Leaves 1 organization: Acme/)).toBeInTheDocument();
    expect(within(dialog).getByText('2 sessions ended')).toBeInTheDocument();
    const go = within(dialog).getByRole('button', { name: 'Offboard' });
    expect(go).toBeDisabled();
    await ui.type(within(dialog).getByLabelText(/Type Ada Lovelace/), 'Ada Lovelace');
    await ui.click(go);
    await waitFor(() => expect(posts).toEqual([{ dryRun: true }, { dryRun: false }]));
  });

  it('blocks the confirm while an org would lose its last admin', async () => {
    await open({
      '/api/v1/users/u2/access': () => json(access()),
      '/api/v1/users/u2/offboard': () =>
        json({
          plan: plan({ blockers: [{ org: { id: 'o1', name: 'Acme' }, code: 'LAST_ORG_ADMIN' }] }),
          operation: null,
        }),
    });
    const ui = userEvent.setup();
    await ui.click(await screen.findByRole('button', { name: 'Offboard' }));
    const dialog = await screen.findByRole('dialog', { name: 'Offboard Ada Lovelace?' });
    expect(await within(dialog).findByText('Acme would lose its last admin.')).toBeInTheDocument();
    await ui.type(within(dialog).getByLabelText(/Type Ada Lovelace/), 'Ada Lovelace');
    expect(within(dialog).getByRole('button', { name: 'Offboard' })).toBeDisabled();
  });
});

describe('Groups and Claims', () => {
  it('lists manual groups and claims, and adds a typed claim', async () => {
    const patches: unknown[] = [];
    await open({
      '/api/v1/users/u2/access': () => json(access()),
      '/api/v1/platform/idp/groups': () =>
        json({
          items: [
            {
              key: 'staff',
              kind: 'custom',
              name: 'passbook_g_staff',
              friendlyName: 'Staff',
              members: 1,
              claims: [],
              otherClients: 0,
              flags: [],
              rules: 0,
              manual: 1,
            },
          ],
          nextCursor: null,
        }),
      '/api/v1/platform/idp/groups/staff/members': () =>
        json({
          items: [{ id: 'gm1', subject: 's1', userId: 'u2', source: 'manual', createdAt: NOW }],
          nextCursor: null,
        }),
      '/api/v1/users/u2/claims': (_u, init) => {
        if (init?.method === 'PATCH') {
          patches.push(JSON.parse(String(init.body)));
          return json({ set: ['dept'], removed: [], dryRun: false });
        }
        return json({ claims: { team: { type: 'text', value: 'ops' } }, otherKeys: 2 });
      },
    });
    const ui = userEvent.setup();
    expect(await screen.findByText('Staff')).toBeInTheDocument();
    expect(await screen.findByText('2 other claims set in Polaris ID')).toBeInTheDocument();
    await ui.click(screen.getByRole('button', { name: 'Add claim' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add claim' });
    await ui.type(within(dialog).getByLabelText(/Key/), 'dept');
    await ui.type(within(dialog).getByLabelText(/Value/), '123');
    await ui.click(within(dialog).getByRole('button', { name: 'Save claim' }));
    await waitFor(() =>
      expect(patches).toEqual([{ set: { dept: { type: 'text', value: '123' } } }]),
    );
  });
});
