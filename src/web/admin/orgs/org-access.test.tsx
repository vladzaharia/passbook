import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import type { OrgInvitation, OrgMember } from '@/shared/contracts/org-membership.ts';
import { membershipsQuery, sessionQuery } from '@/web/lib/session.ts';
import {
  type FetchHandler,
  json,
  membershipFixture,
  problem,
  type RenderAppOptions,
  renderApp as renderBaseApp,
  sessionFixture,
} from '@/web/lib/test-utils.tsx';

function renderApp(path: string, options: RenderAppOptions = {}) {
  return renderBaseApp(`${path}?view=workspace`, {
    memberships: [membershipFixture('o1')],
    selectedOrg: 'o1',
    ...options,
  });
}

const org = {
  id: 'o1',
  slug: 'acme',
  name: 'Acme Gym',
  status: 'active',
  defaultIdentityId: null,
  branding: { accent: '#0f766e' },
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  counts: { passes: 12, templates: 2, connections: 1, apiKeys: 3 },
  countsCapped: false,
};

const membership = (overrides: Partial<OrgMember> = {}): OrgMember => ({
  id: 'member-1',
  orgId: 'o1',
  orgName: 'Acme Gym',
  orgSlug: 'acme',
  userId: 'user-ada',
  userName: 'Ada Lovelace',
  userEmail: 'ada@example.test',
  roles: ['template_author', 'pass_operator'],
  capabilities: ['org:read', 'templates:author', 'passes:operate'],
  createdAt: 1_700_000_000_000,
  revokedAt: null,
  ...overrides,
});

const invitation = (overrides: Partial<OrgInvitation> = {}): OrgInvitation => ({
  id: 'invite-1',
  orgId: 'o1',
  email: 'pending@example.test',
  roles: ['read_only'],
  createdAt: 1_700_000_000_000,
  expiresAt: 4_000_000_000_000,
  revokedAt: null,
  acceptedAt: null,
  ...overrides,
});

const handlers = (extra: Record<string, FetchHandler> = {}) => ({
  '/api/v1/orgs/o1': () => json(org),
  '/api/v1/orgs/o1/workspace': () => json(org),
  '/api/v1/wallet-providers/accounts': (url: URL) =>
    json({
      orgId: 'o1',
      mode: url.searchParams.get('mode'),
      provider: url.searchParams.get('provider'),
      accountId: null,
      revision: 0,
      state: 'absent',
      externalApprovalVerified: false,
      issuance: { state: 'disabled', reason: 'not_released' },
      updatedAt: null,
    }),
  '/api/v1/orgs/o1/memberships': () => json({ items: [] }),
  '/api/v1/orgs/o1/invitations': () => json({ items: [] }),
  '/api/v1/identities': () => json({ items: [], nextCursor: null }),
  '/api/v1/settings': () =>
    json({ items: [], oidc: { issuer: 'https://id.plrs.im', adminGroup: null, userGroup: null } }),
  ...extra,
});

const roleLabels = [
  'Organization admin',
  'Integration admin',
  'Template author',
  'Template reviewer',
  'Template publisher',
  'Pass operator',
  'Read only',
];

async function selectRoles(user: UserEvent, selected: string[]) {
  for (const name of roleLabels) {
    const checkbox = await screen.findByRole('checkbox', { name });
    const checked =
      checkbox.getAttribute('aria-checked') === 'true' ||
      (checkbox instanceof HTMLInputElement && checkbox.checked);
    if (checked !== selected.includes(name)) await user.click(checkbox);
  }
}

function listItem(section: string, text: string): HTMLElement {
  const region = screen.getByRole('region', { name: section });
  const item = within(region)
    .getAllByRole('listitem')
    .find((row) => within(row).queryByText(text));
  expect(item).toBeDefined();
  return item as HTMLElement;
}

describe('organization people and service access', () => {
  it('shows empty members and invitations without hiding service access', async () => {
    await renderApp('/admin/orgs/o1', { session: 'admin', handlers: handlers() });
    expect(await screen.findByText('No active members.')).toBeInTheDocument();
    expect(await screen.findByText('No invitations.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Review API keys' })).toHaveAttribute(
      'href',
      '/admin/api-keys?orgId=o1',
    );
  });

  it('shows people management to a member with members:manage independently of org edits', async () => {
    const { fetchMock } = await renderBaseApp('/admin/orgs/o1?view=workspace&orgId=o1', {
      session: 'user',
      memberships: [membershipFixture('o1', { capabilities: ['org:read', 'members:manage'] })],
      handlers: handlers(),
    });
    expect(
      await screen.findByRole('heading', { name: 'People & service access' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Invite member' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Accent colour')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Review API keys' })).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/v1/identities'))).toBe(
      false,
    );
  });

  it('lists members and invitation states with only pending invitations revocable', async () => {
    const { container, fetchMock } = await renderApp('/admin/orgs/o1', {
      session: 'admin',
      handlers: handlers({
        '/api/v1/orgs/o1/memberships': () =>
          json({
            items: [
              membership(),
              membership({
                id: 'member-2',
                userId: 'user-jo',
                userName: null,
                userEmail: 'jo@example.test',
                roles: ['org_admin'],
              }),
            ],
          }),
        '/api/v1/orgs/o1/invitations': () =>
          json({
            items: [
              invitation(),
              invitation({
                id: 'invite-2',
                email: 'accepted@example.test',
                acceptedAt: 1_700_000_100_000,
              }),
              invitation({
                id: 'invite-3',
                email: 'revoked@example.test',
                revokedAt: 1_700_000_100_000,
              }),
              invitation({
                id: 'invite-4',
                email: 'expired@example.test',
                expiresAt: 1_700_000_100_000,
              }),
            ],
          }),
      }),
    });
    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
    expect(listItem('Members', 'Ada Lovelace')).toHaveTextContent('ada@example.test');
    expect(listItem('Members', 'Ada Lovelace')).toHaveTextContent('Template author, Pass operator');
    expect(listItem('Members', 'jo@example.test')).toHaveTextContent('Organization admin');
    expect(screen.queryByText('user-ada')).toBeNull();
    expect(await screen.findByText('pending@example.test')).toBeInTheDocument();
    expect(listItem('Invitations', 'pending@example.test')).toHaveTextContent('Read only');
    for (const [email, state] of [
      ['pending@example.test', 'Pending'],
      ['accepted@example.test', 'Accepted'],
      ['revoked@example.test', 'Revoked'],
      ['expired@example.test', 'Expired'],
    ] as const) {
      expect(listItem('Invitations', email)).toHaveTextContent(state);
      if (state !== 'Pending') {
        expect(screen.queryByRole('button', { name: `Revoke invitation for ${email}` })).toBeNull();
      }
    }
    expect(screen.getByRole('heading', { name: 'Members' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Invitations' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Revoke membership for Ada Lovelace' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Revoke invitation for pending@example.test' }),
    ).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) => String(url) === '/api/v1/orgs/o1/memberships' && init?.method === 'GET',
      ),
    ).toBe(true);
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) => String(url) === '/api/v1/orgs/o1/invitations' && init?.method === 'GET',
      ),
    ).toBe(true);
    // JSDOM's iframe traversal is unsupported; audit the organization access page itself.
    expect((await axe(container, { iframes: false })).violations).toEqual([]);
  });

  it('invites with multiple selected roles without disclosing a token or link', async () => {
    const secret = 't'.repeat(43);
    const items: OrgInvitation[] = [];
    const posts: { email: string; roles: string[] }[] = [];
    const { container, queryClient } = await renderApp('/admin/orgs/o1', {
      session: 'admin',
      handlers: handlers({
        '/api/v1/orgs/o1/invitations': (_url, init) => {
          if (init?.method === 'POST') {
            posts.push(JSON.parse(String(init.body)));
            const created = invitation({
              email: 'new@example.test',
              roles: ['template_author', 'pass_operator'],
            });
            items.push(created);
            return json({ ...created, token: secret }, 201);
          }
          return json({ items: items.map((item) => ({ ...item, token: secret })) });
        },
      }),
    });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Email'), 'new@example.test');
    await selectRoles(user, ['Template author', 'Pass operator']);
    await user.click(screen.getByRole('button', { name: 'Invite member' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({
      email: 'new@example.test',
      roles: expect.arrayContaining(['template_author', 'pass_operator']),
    });
    expect(posts[0]?.roles).toHaveLength(2);
    expect(await screen.findByText('new@example.test')).toBeInTheDocument();
    expect(await screen.findByText('Invitation sent.')).toBeInTheDocument();
    expect(container).not.toHaveTextContent(secret);
    expect(document.body.innerHTML).not.toContain(secret);
    for (const input of document.querySelectorAll('input, textarea')) {
      expect((input as HTMLInputElement | HTMLTextAreaElement).value).not.toContain(secret);
    }
    expect(
      JSON.stringify(
        queryClient
          .getQueryCache()
          .getAll()
          .map((query) => query.state.data),
      ),
    ).not.toContain(secret);
    expect(
      JSON.stringify(
        queryClient
          .getMutationCache()
          .getAll()
          .map((mutation) => mutation.state.data),
      ),
    ).not.toContain(secret);
    expect(screen.queryByRole('link', { name: /accept invitation|invitation link/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /copy (invitation|link)/i })).toBeNull();
  });

  it.each(['success', 'failure'] as const)(
    'ignores a late workspace invitation %s after the principal changes',
    async (outcome) => {
      // The web test target is ES2023 and does not expose Promise.withResolvers.
      let resolve!: (response: Response) => void;
      const pending = new Promise<Response>((done) => {
        resolve = done;
      });
      let posts = 0;
      let currentUser = 'u1';
      const { queryClient } = await renderApp('/admin/orgs/o1', {
        session: 'admin',
        handlers: handlers({
          '/api/v1/orgs/memberships/me': () =>
            json({ items: [membershipFixture('o1', { userId: currentUser })] }),
          '/api/v1/orgs/o1/invitations': (_url, init) => {
            if (init?.method === 'POST') {
              posts += 1;
              return pending;
            }
            return json({ items: [] });
          },
        }),
      });
      const user = userEvent.setup();
      await user.type(await screen.findByLabelText('Email'), 'new@example.test');
      await selectRoles(user, ['Read only']);
      await user.click(screen.getByRole('button', { name: 'Invite member' }));
      await waitFor(() => expect(posts).toBe(1));
      const mutation = queryClient.getMutationCache().getAll()[0];
      expect(mutation).toBeDefined();

      const next = sessionFixture('admin');
      if (!next.authenticated) throw new Error('Expected an authenticated fixture.');
      currentUser = 'u2';
      act(() => {
        const updatedSession: typeof next = { ...next, user: { ...next.user, id: 'u2' } };
        queryClient.setQueryData(sessionQuery.queryKey, updatedSession);
        queryClient.setQueryData(membershipsQuery.queryKey, {
          items: [membershipFixture('o1', { userId: 'u2' })],
        });
      });
      await waitFor(() => expect(screen.getByLabelText('Email')).toHaveValue(''));
      const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
      await act(async () => {
        resolve(
          outcome === 'success'
            ? json(invitation({ email: 'new@example.test' }), 201)
            : problem(500, 'failed', 'Private server detail.'),
        );
      });
      await waitFor(() => expect(mutation?.state.status).toBe('success'));
      expect(mutation?.state.data).toBeUndefined();
      expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['org-access', 'o1'] });
      expect(screen.queryByText('Invitation sent.')).toBeNull();
      expect(screen.queryByText('Private server detail.')).toBeNull();
      expect(screen.getByLabelText('Email')).toHaveValue('');
      invalidate.mockRestore();
    },
  );

  it('revokes the chosen membership and invitation and refreshes both lists', async () => {
    let members = [
      membership(),
      membership({
        id: 'member-2',
        userId: 'user-jo',
        userName: null,
        userEmail: 'jo@example.test',
        roles: ['org_admin'],
      }),
    ];
    let invitations = [invitation(), invitation({ id: 'invite-2', email: 'other@example.test' })];
    const deletes: string[] = [];
    await renderApp('/admin/orgs/o1', {
      session: 'admin',
      handlers: handlers({
        '/api/v1/orgs/o1/memberships': () => json({ items: members }),
        '/api/v1/orgs/o1/invitations': () => json({ items: invitations }),
        '/api/v1/orgs/o1/memberships/member-1': (url, init) => {
          deletes.push(`${init?.method} ${url.pathname}`);
          members = members.filter((member) => member.id !== 'member-1');
          return json({ ok: true });
        },
        '/api/v1/orgs/o1/invitations/invite-1': (url, init) => {
          deletes.push(`${init?.method} ${url.pathname}`);
          invitations = invitations.map((item) =>
            item.id === 'invite-1' ? { ...item, revokedAt: 1_800_000_000_000 } : item,
          );
          return json({ ok: true });
        },
      }),
    });
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', { name: 'Revoke membership for Ada Lovelace' }),
    );
    const confirm = await screen.findByRole('alertdialog', { name: 'Revoke Ada Lovelace?' });
    expect(deletes).toEqual([]);
    await user.click(within(confirm).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(screen.queryByText('Ada Lovelace')).toBeNull());
    expect(screen.getByText('jo@example.test')).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Revoke invitation for pending@example.test' }),
      ).toBeEnabled(),
    );
    await user.click(
      await screen.findByRole('button', { name: 'Revoke invitation for pending@example.test' }),
    );
    await user.click(
      within(
        await screen.findByRole('alertdialog', {
          name: 'Revoke the invitation for pending@example.test?',
        }),
      ).getByRole('button', { name: 'Revoke' }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Revoke invitation for pending@example.test' }),
      ).toBeNull(),
    );
    expect(listItem('Invitations', 'pending@example.test')).toHaveTextContent('Revoked');
    expect(
      screen.getByRole('button', { name: 'Revoke invitation for other@example.test' }),
    ).toBeInTheDocument();
    expect(deletes).toEqual([
      'DELETE /api/v1/orgs/o1/memberships/member-1',
      'DELETE /api/v1/orgs/o1/invitations/invite-1',
    ]);
  });

  it('refetches current memberships and clears a revoked organization from the scope', async () => {
    const current = membershipFixture('o1', { id: 'member-1', orgName: org.name });
    const other = membershipFixture('o2', { orgName: 'Other organization' });
    let currentMemberships = [current, other];
    let membershipRequests = 0;
    const { queryClient } = await renderApp('/admin/orgs/o1', {
      session: 'admin',
      selectedOrg: 'o1',
      handlers: handlers({
        '/api/v1/orgs/memberships/me': () => {
          membershipRequests += 1;
          return json({ items: currentMemberships });
        },
        '/api/v1/orgs/o1/memberships': () =>
          json({
            items: currentMemberships
              .filter((m) => m.orgId === 'o1')
              .map((m) => ({ ...m, userName: null, userEmail: 'u1@example.test' })),
          }),
        '/api/v1/orgs/o1/memberships/member-1': (_url, init) => {
          expect(init?.method).toBe('DELETE');
          currentMemberships = [other];
          return json({ ok: true });
        },
      }),
    });
    const user = userEvent.setup();
    const picker = await screen.findByRole('combobox', { name: /^Organization filter/ });
    await waitFor(() => expect(picker).toHaveTextContent(org.name));
    const requestsBeforeRevoke = membershipRequests;

    await user.click(
      await screen.findByRole('button', { name: 'Revoke membership for u1@example.test' }),
    );
    const own = await screen.findByRole('alertdialog', { name: /^Remove your access to / });
    await user.click(within(own).getByRole('button', { name: 'Remove my access' }));
    await waitFor(() => {
      expect(membershipRequests).toBeGreaterThan(requestsBeforeRevoke);
      expect(queryClient.getQueryData(['org-memberships', 'me'])).toEqual({ items: [other] });
    });
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: /^Organization filter/ })).toHaveTextContent(
        'Choose an organization',
      ),
    );
    await user.click(screen.getByRole('combobox', { name: /^Organization filter/ }));
    expect(screen.queryByRole('option', { name: org.name })).toBeNull();
    expect(await screen.findByRole('option', { name: 'Other organization' })).toBeInTheDocument();
  });

  it('reports rejected revocations without removing access', async () => {
    const deletes: string[] = [];
    const reject: FetchHandler = (url, init) => {
      deletes.push(`${init?.method} ${url.pathname}`);
      return problem(503, 'unavailable', 'private server detail');
    };
    await renderApp('/admin/orgs/o1', {
      session: 'admin',
      handlers: handlers({
        '/api/v1/orgs/o1/memberships': () => json({ items: [membership()] }),
        '/api/v1/orgs/o1/invitations': () => json({ items: [invitation()] }),
        '/api/v1/orgs/o1/memberships/member-1': reject,
        '/api/v1/orgs/o1/invitations/invite-1': reject,
      }),
    });
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', { name: 'Revoke membership for Ada Lovelace' }),
    );
    let confirm = await screen.findByRole('alertdialog', { name: 'Revoke Ada Lovelace?' });
    await user.click(within(confirm).getByRole('button', { name: 'Revoke' }));
    expect(await within(confirm).findByRole('alert')).toHaveTextContent(
      'Something went wrong. Try again.',
    );
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    await user.click(
      await screen.findByRole('button', { name: 'Revoke invitation for pending@example.test' }),
    );
    confirm = await screen.findByRole('alertdialog', {
      name: 'Revoke the invitation for pending@example.test?',
    });
    await user.click(within(confirm).getByRole('button', { name: 'Revoke' }));
    await waitFor(() =>
      expect(deletes).toEqual([
        'DELETE /api/v1/orgs/o1/memberships/member-1',
        'DELETE /api/v1/orgs/o1/invitations/invite-1',
      ]),
    );
    expect(await within(confirm).findByRole('alert')).toHaveTextContent(
      'Something went wrong. Try again.',
    );
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(listItem('Invitations', 'pending@example.test')).toHaveTextContent('Pending');
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.queryByText('private server detail')).toBeNull();
  });

  it.each([
    ['memberships', 'Members', 'No active members.', 'pending@example.test'],
    ['invitations', 'Invitations', 'No invitations.', 'Ada Lovelace'],
  ] as const)(
    'shows a %s server error rather than an empty list',
    async (resource, name, empty, other) => {
      await renderApp('/admin/orgs/o1', {
        session: 'admin',
        handlers: handlers({
          '/api/v1/orgs/o1/memberships': () => json({ items: [membership()] }),
          '/api/v1/orgs/o1/invitations': () => json({ items: [invitation()] }),
          [`/api/v1/orgs/o1/${resource}`]: () =>
            problem(500, 'internal_error', 'private server detail'),
        }),
      });
      const section = await screen.findByRole('region', { name });
      expect(await within(section).findByRole('alert')).toHaveTextContent(
        'Something went wrong. Try again.',
      );
      expect(within(section).queryByText(empty)).toBeNull();
      expect(await screen.findByText(other)).toBeInTheDocument();
      expect(screen.queryByText('private server detail')).toBeNull();
    },
  );

  it('keeps an invitation draft and reports a failed server request', async () => {
    const posts: unknown[] = [];
    await renderApp('/admin/orgs/o1', {
      session: 'admin',
      handlers: handlers({
        '/api/v1/orgs/o1/invitations': (_url, init) => {
          if (init?.method === 'POST') {
            posts.push(JSON.parse(String(init.body)));
            return problem(503, 'unavailable', 'private server detail');
          }
          return json({ items: [] });
        },
      }),
    });
    const user = userEvent.setup();
    const email = await screen.findByLabelText('Email');
    await user.type(email, 'new@example.test');
    await selectRoles(user, ['Integration admin']);
    await user.click(screen.getByRole('button', { name: 'Invite member' }));
    await waitFor(() =>
      expect(posts).toEqual([{ email: 'new@example.test', roles: ['integration_admin'] }]),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong. Try again.');
    expect(email).toHaveValue('new@example.test');
    expect(screen.getByRole('checkbox', { name: 'Integration admin' })).toBeChecked();
    expect(screen.queryByText('private server detail')).toBeNull();
  });

  it('shows the server refusal to revoke the last organization admin inside the dialog', async () => {
    await renderApp('/admin/orgs/o1', {
      session: 'admin',
      handlers: handlers({
        '/api/v1/orgs/o1/memberships': () => json({ items: [membership()] }),
        '/api/v1/orgs/o1/memberships/member-1': () =>
          problem(
            409,
            'LAST_ORG_ADMIN',
            'This is the last org admin. Make someone else an org admin first.',
          ),
      }),
    });
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', { name: 'Revoke membership for Ada Lovelace' }),
    );
    const confirm = await screen.findByRole('alertdialog', { name: 'Revoke Ada Lovelace?' });
    await user.click(within(confirm).getByRole('button', { name: 'Revoke' }));
    expect(await within(confirm).findByRole('alert')).toHaveTextContent(
      'This is the last org admin. Make someone else an org admin first.',
    );
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
  });

  it('flags the invitation fields and sends nothing until both are valid', async () => {
    const posts: unknown[] = [];
    await renderApp('/admin/orgs/o1', {
      session: 'admin',
      handlers: handlers({
        '/api/v1/orgs/o1/invitations': (_url, init) => {
          if (init?.method === 'POST') posts.push(init.body);
          return json({ items: [] });
        },
      }),
    });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Email'), 'not-an-email');
    await user.click(screen.getByRole('button', { name: 'Invite member' }));
    expect(await screen.findByText('Enter a valid email address.')).toBeInTheDocument();
    expect(screen.getByText('Choose at least one role.')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveAccessibleDescription(
      'Enter a valid email address.',
    );
    expect(posts).toEqual([]);
  });
});
