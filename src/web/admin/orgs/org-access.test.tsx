import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { json, membershipFixture, problem } from '@/web/lib/test-utils.tsx';
import { toast } from '@/web/ui/toaster.tsx';
import { handlers, invitation, lists, member, renderMembers } from './org-access-fixtures.ts';

afterEach(() => vi.restoreAllMocks());

const pat = member({ id: 'm-own', userId: 'u1', userName: 'Pat', userEmail: 'pat@example.test' });
const jo = member({
  id: 'member-2',
  userId: 'user-jo',
  userName: null,
  userEmail: 'jo@example.test',
  roles: ['org_admin'],
});
const ada = member({ roles: ['template_author', 'pass_operator', 'integration_admin'] });

describe('Members page', () => {
  it('shows the one-member empty state with one Invite button and no Invitations section', async () => {
    await renderMembers({ handlers: handlers(lists([pat])) });
    expect(await screen.findByText('Invite your team')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Invite member' })).toHaveLength(2);
    expect(screen.queryByText(/Invitations/)).toBeNull();
    expect(screen.queryByText('No invitations.')).toBeNull();
  });

  it('lists members with You, email, role badges and +N, and a section only for pending invitations', async () => {
    const { container } = await renderMembers({
      handlers: handlers(
        lists(
          [pat, ada, jo],
          [
            invitation(),
            invitation({
              id: 'i-a',
              email: 'accepted@example.test',
              acceptedAt: 1_700_000_050_000,
            }),
            invitation({ id: 'i-r', email: 'revoked@example.test', revokedAt: 1_700_000_050_000 }),
          ],
        ),
      ),
    });
    expect(await screen.findByText('Pat')).toBeInTheDocument();
    expect(screen.getByText('You')).toBeInTheDocument();
    expect(screen.getByText('ada@example.test')).toBeInTheDocument();
    expect(screen.getByLabelText('1 more: Integration admin')).toHaveTextContent('+1');
    expect(screen.queryByText('Invite your team')).toBeNull();
    const section = await screen.findByRole('list', { name: 'Invitations' });
    expect(within(section).getByText('pending@example.test')).toBeInTheDocument();
    expect(within(section).queryByText('accepted@example.test')).toBeNull();
    expect(within(section).queryByText('revoked@example.test')).toBeNull();
    expect(section).toHaveTextContent('Read only · Sent');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('offers no Remove on your own row or the last organization admin', async () => {
    const lone = member({
      id: 'm-lone',
      userId: 'user-lone',
      userName: 'Lone',
      roles: ['org_admin'],
    });
    await renderMembers({ handlers: handlers(lists([pat, ada, lone])) });
    await screen.findByText('Lone');
    expect(screen.queryByRole('button', { name: 'Remove Pat' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove Lone' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove Ada Lovelace' })).toBeInTheDocument();
  });

  it('offers Remove for an admin when another admin remains', async () => {
    await renderMembers({
      handlers: handlers(
        lists([pat, jo, member({ id: 'm3', userId: 'u3', userName: 'Kim', roles: ['org_admin'] })]),
      ),
    });
    await screen.findByText('Kim');
    expect(screen.getByRole('button', { name: 'Remove Kim' })).toBeInTheDocument();
  });

  it('has no invite or remove on a personal org', async () => {
    await renderMembers({
      memberships: [membershipFixture('o1', { personal: true })],
      handlers: handlers(lists([pat])),
    });
    expect(await screen.findByText('Pat')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Invite/ })).toBeNull();
    expect(screen.queryByText('Invite your team')).toBeNull();
  });

  it('shows people management to a member with members:manage only', async () => {
    const { fetchMock } = await renderMembers({
      session: 'user',
      memberships: [membershipFixture('o1', { capabilities: ['org:read', 'members:manage'] })],
      handlers: handlers(lists([pat, ada])),
    });
    expect(await screen.findByRole('button', { name: 'Invite member' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Accent colour')).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/v1/identities'))).toBe(
      false,
    );
  });

  it('removes a member after confirming and refreshes the list', async () => {
    let members = [pat, ada];
    const deletes: string[] = [];
    await renderMembers({
      handlers: handlers({
        '/api/v1/orgs/o1/memberships': () => json({ items: members, nextCursor: null }),
        '/api/v1/orgs/o1/memberships/member-1': (url, init) => {
          deletes.push(`${init?.method} ${url.pathname}`);
          members = members.filter((m) => m.id !== 'member-1');
          return json({ ok: true });
        },
      }),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Remove Ada Lovelace' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Remove Ada Lovelace?' });
    expect(deletes).toEqual([]);
    await user.click(within(confirm).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryByText('Ada Lovelace')).toBeNull());
    expect(deletes).toEqual(['DELETE /api/v1/orgs/o1/memberships/member-1']);
  });

  it('shows the server refusal inside the dialog and keeps the member', async () => {
    await renderMembers({
      handlers: handlers({
        ...lists([pat, ada]),
        '/api/v1/orgs/o1/memberships/member-1': () =>
          problem(
            409,
            'LAST_ORG_ADMIN',
            'This is the last org admin. Make someone else an org admin first.',
          ),
      }),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Remove Ada Lovelace' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Remove Ada Lovelace?' });
    await user.click(within(confirm).getByRole('button', { name: 'Remove' }));
    expect(await within(confirm).findByRole('alert')).toHaveTextContent(
      'This is the last org admin.',
    );
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
  });

  it('revokes an invitation after confirming', async () => {
    const deletes: string[] = [];
    let items = [invitation(), invitation({ id: 'invite-2', email: 'other@example.test' })];
    await renderMembers({
      handlers: handlers({
        '/api/v1/orgs/o1/memberships': () => json({ items: [pat, ada], nextCursor: null }),
        '/api/v1/orgs/o1/invitations': () => json({ items, nextCursor: null }),
        '/api/v1/orgs/o1/invitations/invite-1': (url, init) => {
          deletes.push(`${init?.method} ${url.pathname}`);
          items = items.filter((i) => i.id !== 'invite-1');
          return json({ ok: true });
        },
      }),
    });
    const user = userEvent.setup();
    const row = (await screen.findByText('pending@example.test')).closest('li') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'Actions for pending@example.test' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Revoke' }));
    const confirm = await screen.findByRole('alertdialog', {
      name: 'Revoke the invitation for pending@example.test?',
    });
    await user.click(within(confirm).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(screen.queryByText('pending@example.test')).toBeNull());
    expect(screen.getByText('other@example.test')).toBeInTheDocument();
    expect(deletes).toEqual(['DELETE /api/v1/orgs/o1/invitations/invite-1']);
  });

  it('resends by revoking the old invitation and inviting the address again', async () => {
    const sent = vi.spyOn(toast, 'sent');
    const calls: string[] = [];
    await renderMembers({
      handlers: handlers({
        '/api/v1/orgs/o1/memberships': () => json({ items: [pat, ada], nextCursor: null }),
        '/api/v1/orgs/o1/invitations': (_url, init) => {
          if (init?.method === 'POST') {
            calls.push(`POST ${init.body}`);
            return json(invitation({ id: 'invite-9' }), 201);
          }
          return json({ items: [invitation()], nextCursor: null });
        },
        '/api/v1/orgs/o1/invitations/invite-1': (_url, init) => {
          calls.push(String(init?.method));
          return json({ ok: true });
        },
      }),
    });
    const user = userEvent.setup();
    const row = (await screen.findByText('pending@example.test')).closest('li') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'Actions for pending@example.test' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Resend' }));
    await waitFor(() =>
      expect(sent).toHaveBeenCalledWith('Invitation sent to pending@example.test'),
    );
    expect(calls).toEqual([
      'DELETE',
      'POST {"email":"pending@example.test","roles":["read_only"]}',
    ]);
  });

  it('shows a server error rather than an empty list', async () => {
    await renderMembers({
      handlers: handlers({
        ...lists([pat]),
        '/api/v1/orgs/o1/invitations': () =>
          problem(500, 'internal_error', 'private server detail'),
      }),
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong. Try again.');
    expect(screen.queryByText('private server detail')).toBeNull();
    expect(screen.getByText('Pat')).toBeInTheDocument();
  });
});
