import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { membershipsQuery, sessionQuery } from '@/web/lib/session.ts';
import { json, membershipFixture, problem, sessionFixture } from '@/web/lib/test-utils.tsx';
import { toast } from '@/web/ui/toaster.tsx';
import { handlers, invitation, renderMembers } from './org-access-fixtures.ts';

afterEach(() => vi.restoreAllMocks());

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Invite member' }));
  return screen.findByRole('dialog', { name: 'Invite member' });
}

describe('invite dialog', () => {
  it('opens from the page header and has no axe violations', async () => {
    await renderMembers({ handlers: handlers() });
    const dialog = await openDialog(userEvent.setup());
    expect(within(dialog).getAllByRole('checkbox')).toHaveLength(7);
    expect(await axe(dialog)).toHaveNoViolations();
  });

  it('turns comma and newline separated addresses into chips and invites each', async () => {
    const sent = vi.spyOn(toast, 'sent');
    const posts: { email: string; roles: string[] }[] = [];
    await renderMembers({
      handlers: handlers({
        '/api/v1/orgs/o1/invitations': (_url, init) => {
          if (init?.method === 'POST') {
            const body = JSON.parse(String(init.body));
            posts.push(body);
            return json(invitation({ email: body.email, roles: body.roles }), 201);
          }
          return json({ items: [], nextCursor: null });
        },
      }),
    });
    const user = userEvent.setup();
    const dialog = await openDialog(user);
    const field = within(dialog).getByLabelText('Emails');
    await user.type(field, 'a@example.test, B@Example.test{Enter}c@example.test');
    expect(
      within(dialog).getByRole('button', { name: 'Remove b@example.test' }),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole('checkbox', { name: 'Template author' }));
    await user.click(within(dialog).getByRole('checkbox', { name: 'Pass operator' }));
    await user.click(within(dialog).getByRole('button', { name: 'Invite 3' }));
    await waitFor(() => expect(posts).toHaveLength(3));
    expect(posts.map((p) => p.email)).toEqual([
      'a@example.test',
      'b@example.test',
      'c@example.test',
    ]);
    expect(posts[0]?.roles).toEqual(['template_author', 'pass_operator']);
    await waitFor(() => expect(sent).toHaveBeenCalledWith('3 invitations sent'));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Invite member' })).toBeNull());
  });

  it('splits pasted lists and removes a chip with Backspace', async () => {
    await renderMembers({ handlers: handlers() });
    const user = userEvent.setup();
    const dialog = await openDialog(user);
    const field = within(dialog).getByLabelText('Emails');
    await user.click(field);
    await user.paste('x@example.test\ny@example.test');
    expect(
      within(dialog).getByRole('button', { name: 'Remove y@example.test' }),
    ).toBeInTheDocument();
    await user.keyboard('{Backspace}');
    expect(within(dialog).queryByRole('button', { name: 'Remove y@example.test' })).toBeNull();
    expect(
      within(dialog).getByRole('button', { name: 'Remove x@example.test' }),
    ).toBeInTheDocument();
  });

  it('flags the fields and sends nothing until both are valid', async () => {
    const posts: unknown[] = [];
    await renderMembers({
      handlers: handlers({
        '/api/v1/orgs/o1/invitations': (_url, init) => {
          if (init?.method === 'POST') posts.push(init.body);
          return json({ items: [], nextCursor: null });
        },
      }),
    });
    const user = userEvent.setup();
    const dialog = await openDialog(user);
    await user.type(within(dialog).getByLabelText('Emails'), 'not-an-email,');
    await user.click(within(dialog).getByRole('button', { name: 'Invite' }));
    expect(await within(dialog).findByText('Enter valid email addresses.')).toBeInTheDocument();
    expect(within(dialog).getByText('Choose at least one role.')).toBeInTheDocument();
    expect(posts).toEqual([]);
  });

  it('keeps the refused address with the reason and the roles', async () => {
    const error = vi.spyOn(toast, 'error');
    await renderMembers({
      handlers: handlers({
        '/api/v1/orgs/o1/invitations': (_url, init) =>
          init?.method === 'POST'
            ? problem(503, 'unavailable', 'private server detail')
            : json({ items: [], nextCursor: null }),
      }),
    });
    const user = userEvent.setup();
    const dialog = await openDialog(user);
    await user.type(within(dialog).getByLabelText('Emails'), 'new@example.test,');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Integration admin' }));
    await user.click(within(dialog).getByRole('button', { name: 'Invite' }));
    expect(
      await within(dialog).findByText('new@example.test: Something went wrong. Try again.'),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('checkbox', { name: 'Integration admin' })).toBeChecked();
    expect(error).toHaveBeenCalledWith('Something went wrong. Try again.', 'Could not invite');
    expect(screen.queryByText(/private server detail/)).toBeNull();
  });

  it('drops a late answer after the signed-in person changes', async () => {
    const sent = vi.spyOn(toast, 'sent');
    let resolve!: (response: Response) => void;
    const pending = new Promise<Response>((done) => {
      resolve = done;
    });
    let currentUser = 'u1';
    const { queryClient } = await renderMembers({
      handlers: handlers({
        '/api/v1/orgs/memberships/me': () =>
          json({ items: [membershipFixture('o1', { userId: currentUser })], nextCursor: null }),
        '/api/v1/orgs/o1/invitations': (_url, init) =>
          init?.method === 'POST' ? pending : json({ items: [], nextCursor: null }),
      }),
    });
    const user = userEvent.setup();
    const dialog = await openDialog(user);
    await user.type(within(dialog).getByLabelText('Emails'), 'new@example.test,');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Read only' }));
    await user.click(within(dialog).getByRole('button', { name: 'Invite' }));
    const next = sessionFixture('admin');
    if (!next.authenticated) throw new Error('Expected an authenticated fixture.');
    currentUser = 'u2';
    act(() => {
      queryClient.setQueryData(sessionQuery.queryKey, {
        ...next,
        user: { ...next.user, id: 'u2' },
      });
      queryClient.setQueryData(membershipsQuery.queryKey, {
        items: [membershipFixture('o1', { userId: 'u2' })],
      });
    });
    await act(async () => {
      resolve(json(invitation({ email: 'new@example.test' }), 201));
    });
    expect(sent).not.toHaveBeenCalled();
  });
});
