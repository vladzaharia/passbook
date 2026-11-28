import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { IDP_COPY } from '@/shared/copy/idp.ts';
import { json, problem, renderApp, sessionFixture } from '@/web/lib/test-utils.tsx';

const group = (over: Record<string, unknown>) => ({
  key: 'partners',
  kind: 'custom',
  name: 'passbook_g_partners',
  friendlyName: 'Partner apps',
  members: 0,
  claims: [],
  otherClients: 0,
  flags: [],
  rules: 0,
  manual: 0,
  ...over,
});
const GROUPS = [
  group({
    key: 'console',
    kind: 'role',
    name: 'passbook_console',
    friendlyName: 'Console',
    members: 12,
  }),
  group({
    key: 'support',
    kind: 'role',
    name: 'passbook_support',
    friendlyName: null,
    members: null,
    flags: ['group_not_found'],
  }),
  group({}),
  group({
    key: 'staffers',
    name: 'passbook_g_staffers',
    friendlyName: 'Staffers',
    members: 3,
    manual: 3,
  }),
  group({ key: 'shared', name: 'passbook_g_shared', friendlyName: 'Shared', otherClients: 2 }),
];
const connected = (v = true) => ({
  connected: v,
  mode: 'live',
  frozen: false,
  keyExpiresAt: null,
  problems: [],
  budget: {},
  lastScimAt: null,
  drift: {},
  breakerOpen: false,
});
const handlers = (over: Record<string, (u: URL, i?: RequestInit) => Response> = {}) => ({
  '/api/v1/platform/idp': () => json(connected()),
  '/api/v1/platform/idp/groups': () => json({ items: GROUPS, nextCursor: null }),
  ...over,
});

describe('Groups page', () => {
  it('shows nothing but a line while the binding is absent, and no nav entry', async () => {
    await renderApp('/admin/platform/groups', {
      session: 'admin',
      handlers: handlers({ '/api/v1/platform/idp': () => json(connected(false)) }),
    });
    expect(await screen.findByText('Polaris ID is not connected')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Groups' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'New group' })).toBeNull();
  });

  it('lists groups by kind, with the nav entry, and is accessible', async () => {
    const { container } = await renderApp('/admin/platform/groups', {
      session: 'admin',
      handlers: handlers(),
    });
    expect(await screen.findByRole('link', { name: 'Partner apps' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Groups' })).toBeInTheDocument();
    expect(screen.getByText('passbook_g_partners')).toBeInTheDocument();
    expect(screen.getAllByText('Memberships and grants')).toHaveLength(2);
    expect(screen.getByText('3 manual')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create in Polaris ID' })).toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('says there are no custom groups, with the buddy, when only roles exist', async () => {
    await renderApp('/admin/platform/groups', {
      session: 'admin',
      handlers: handlers({
        '/api/v1/platform/idp/groups': () => json({ items: [GROUPS[0]], nextCursor: null }),
      }),
    });
    expect(await screen.findByText('No custom groups.')).toBeInTheDocument();
  });

  it('creates a group through the wizard: name, key from the name, rules, review', async () => {
    const bodies: unknown[] = [];
    await renderApp('/admin/platform/groups', {
      session: 'admin',
      handlers: handlers({
        '/api/v1/platform/idp/groups': (_u, init) => {
          if (init?.method === 'POST') {
            bodies.push(JSON.parse(String(init.body)));
            return json({ key: 'north_wing', dryRun: false }, 201);
          }
          return json({ items: GROUPS, nextCursor: null });
        },
      }),
    });
    const user = userEvent.setup();
    await user.click(
      (await screen.findAllByRole('button', { name: 'New group' }))[0] as HTMLElement,
    );
    const dialog = await screen.findByRole('dialog', { name: 'New group' });
    await user.type(within(dialog).getByLabelText(/^Name/), 'North Wing');
    expect(within(dialog).getByLabelText(/^Key/)).toHaveValue('north_wing');
    expect(within(dialog).getByText('passbook_g_north_wing')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Next' }));
    expect(await within(dialog).findByText(/No org rules/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Next' }));
    expect(
      await within(dialog).findByRole('heading', { name: 'Check and create' }),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Create group' }));
    await waitFor(() =>
      expect(bodies).toEqual([{ key: 'north_wing', friendlyName: 'North Wing' }]),
    );
    expect(await screen.findByText('Group created')).toBeInTheDocument();
  });

  it('refuses a reserved key and blocks Next with a hint', async () => {
    await renderApp('/admin/platform/groups', { session: 'admin', handlers: handlers() });
    const user = userEvent.setup();
    await user.click(
      (await screen.findAllByRole('button', { name: 'New group' }))[0] as HTMLElement,
    );
    const dialog = await screen.findByRole('dialog', { name: 'New group' });
    await user.type(within(dialog).getByLabelText(/^Name/), 'Console');
    await user.click(within(dialog).getByRole('button', { name: 'Next' }));
    expect(await within(dialog).findByText('This key is reserved.')).toBeInTheDocument();
  });

  it('disables Delete with its reason, and shows the server refusal when it still refuses', async () => {
    await renderApp('/admin/platform/groups', {
      session: 'admin',
      handlers: handlers({
        '/api/v1/platform/idp/groups/partners': (_u, init) =>
          init?.method === 'DELETE'
            ? problem(409, 'IDP_IN_USE', 'Used by other apps in Polaris ID.')
            : json({}),
      }),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Actions for Staffers' }));
    expect(await screen.findByRole('menuitem', { name: 'Delete' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByText('Has members.')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Actions for Shared' }));
    expect(screen.getByText('Used by other apps in Polaris ID.')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Actions for Partner apps' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete Partner apps?' });
    await user.type(within(confirm).getByRole('textbox'), 'partners');
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }));
    expect(
      await within(confirm).findByText('Used by other apps in Polaris ID.'),
    ).toBeInTheDocument();
  });

  it('creates a role group from its row', async () => {
    const bodies: unknown[] = [];
    await renderApp('/admin/platform/groups', {
      session: 'admin',
      handlers: handlers({
        '/api/v1/platform/idp/groups/ensure': (_u, init) => {
          bodies.push(JSON.parse(String(init?.body)));
          return json({ key: 'support', dryRun: false }, 201);
        },
      }),
    });
    await userEvent
      .setup()
      .click(await screen.findByRole('button', { name: 'Create in Polaris ID' }));
    await waitFor(() => expect(bodies).toEqual([{ role: 'support' }]));
  });
});

describe('Group detail', () => {
  const detail = (key = 'partners') => ({
    ...handlers(),
    [`/api/v1/platform/idp/groups/${key}/rules`]: () =>
      json({
        items: [{ id: 'r1', orgId: 'o1', orgRoles: ['org_admin'], createdAt: 1 }],
        nextCursor: null,
      }),
    [`/api/v1/platform/idp/groups/${key}/members`]: () =>
      json({
        items: [
          { id: 'm1', subject: 'a1b2c3d4-e5f6-7788', userId: null, source: 'manual', createdAt: 1 },
        ],
        nextCursor: null,
      }),
    [`/api/v1/platform/idp/groups/${key}/claims`]: () =>
      json({ claims: { passbook_plan: { type: 'text', value: 'gold' } }, otherKeys: 2 }),
    '/api/v1/orgs': () =>
      json({
        items: [
          {
            id: 'o1',
            slug: 'north',
            name: 'Northwind',
            status: 'active',
            personal: false,
            createdAt: 1,
            counts: { passes: 0, templates: 0, connections: 0, apiKeys: 0 },
            countsCapped: false,
            personalOwner: null,
          },
        ],
        nextCursor: null,
      }),
  });

  it('shows rules, manual members and claims, with the count of other claims', async () => {
    const { container } = await renderApp('/admin/platform/groups/partners', {
      session: 'admin',
      handlers: detail(),
    });
    expect(await screen.findByRole('heading', { name: 'Partner apps' })).toBeInTheDocument();
    expect(await screen.findByText('Northwind')).toBeInTheDocument();
    expect(screen.getByText('Organization admin')).toBeInTheDocument();
    expect(await screen.findByText('Polaris ID account')).toBeInTheDocument();
    expect(screen.getByText('passbook_plan')).toBeInTheDocument();
    expect(screen.getByText('2 other claims set in Polaris ID.')).toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);
  });

  describe.each([
    ['fresh', 'oidc', 0, 'passbook_plan'],
    ['stale', 'oidc', 11 * 60_000, IDP_COPY.claimsStale],
    ['break-glass', 'breakglass', 0, IDP_COPY.claimsBreakGlass],
  ] as const)('claims on a %s session', (state, amr, age, expected) => {
    it('asks only when the session qualifies', async () => {
      const asked: string[] = [];
      await renderApp('/admin/platform/groups/partners', {
        session: 'admin',
        handlers: {
          ...detail(),
          '/api/v1/session': () =>
            json({ ...sessionFixture('admin', amr), authTime: Date.now() - age }),
          '/api/v1/platform/idp/groups/partners/claims': () => {
            asked.push('claims');
            return json({
              claims: { passbook_plan: { type: 'text', value: 'gold' } },
              otherKeys: 0,
            });
          },
        },
      });
      expect(await screen.findByText(expected)).toBeInTheDocument();
      expect(asked).toEqual(state === 'fresh' ? ['claims'] : []);
    });
  });

  it('sets a typed claim', async () => {
    const bodies: unknown[] = [];
    const h = detail();
    await renderApp('/admin/platform/groups/partners', {
      session: 'admin',
      handlers: {
        ...h,
        '/api/v1/platform/idp/groups/partners/claims': (_u, init) => {
          if (init?.method === 'PATCH') {
            bodies.push(JSON.parse(String(init.body)));
            return json({ set: ['passbook_seats'], removed: [], dryRun: false });
          }
          return json({ claims: {}, otherKeys: 0 });
        },
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add claim' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add claim' });
    const key = within(dialog).getByLabelText(/^Key/);
    await user.clear(key);
    await user.type(key, 'passbook_seats');
    await user.click(within(dialog).getByRole('combobox', { name: /Type/ }));
    await user.click(await screen.findByRole('option', { name: 'Number' }));
    await user.type(within(dialog).getByLabelText(/^Value/), '12');
    await user.click(within(dialog).getByRole('button', { name: 'Save claim' }));
    await waitFor(() =>
      expect(bodies).toEqual([{ set: { passbook_seats: { type: 'number', value: 12 } } }]),
    );
  });

  it('answers a missing group with its not-found page', async () => {
    await renderApp('/admin/platform/groups/nope', { session: 'admin', handlers: handlers() });
    expect(await screen.findByText(/not found/i)).toBeInTheDocument();
  });
});
