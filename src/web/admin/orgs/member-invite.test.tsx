import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { membershipsQuery, sessionQuery } from '@/web/lib/session.ts';
import { json, membershipFixture, problem, sessionFixture } from '@/web/lib/test-utils.tsx';
import { handlers, invitation, renderMembers } from './org-access-fixtures.ts';

afterEach(() => vi.restoreAllMocks());

type User = ReturnType<typeof userEvent.setup>;
const post = (posts: unknown[]) => (_url: URL, init?: RequestInit) => {
  if (init?.method !== 'POST') return json({ items: [], nextCursor: null });
  const body = JSON.parse(String(init.body));
  posts.push(body);
  return json(invitation({ email: body.email, roles: body.roles }), 201);
};
async function openWizard(user: User) {
  await user.click(await screen.findByRole('button', { name: 'Invite member' }));
  return screen.findByRole('dialog', { name: 'Invite member' });
}
const next = (user: User, dialog: HTMLElement) =>
  user.click(within(dialog).getByRole('button', { name: /^(Next|Review)$/ }));

describe('Invite wizard on Members', () => {
  it('opens from the page header on Person and has no axe violations', async () => {
    await renderMembers({ handlers: handlers() });
    const dialog = await openWizard(userEvent.setup());
    expect(within(dialog).getByLabelText('Emails')).toBeInTheDocument();
    expect((await axe(dialog)).violations).toEqual([]);
  });

  it('walks Person, Access and Review, then invites each address and shows Done', async () => {
    const posts: { email: string; roles: string[] }[] = [];
    await renderMembers({
      handlers: handlers({ '/api/v1/orgs/o1/invitations': post(posts) }),
    });
    const user = userEvent.setup();
    const dialog = await openWizard(user);
    await user.type(
      within(dialog).getByLabelText('Emails'),
      'a@example.test, B@Example.test{Enter}c@example.test',
    );
    await next(user, dialog);
    await user.click(within(dialog).getByRole('checkbox', { name: 'Template author' }));
    await user.click(within(dialog).getByRole('checkbox', { name: 'Pass operator' }));
    await next(user, dialog);
    expect(
      within(dialog).getByText('a@example.test, b@example.test, c@example.test'),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Send 3' }));
    await waitFor(() => expect(posts).toHaveLength(3));
    expect(posts.map((p) => p.email)).toEqual([
      'a@example.test',
      'b@example.test',
      'c@example.test',
    ]);
    expect(posts[0]?.roles).toEqual(['template_author', 'pass_operator']);
    expect(await screen.findByText('Invitation sent to a•••@example.test.')).toBeInTheDocument();
  });

  it('holds Next on Person until an address is valid, and on Access until a role is chosen', async () => {
    const posts: unknown[] = [];
    await renderMembers({ handlers: handlers({ '/api/v1/orgs/o1/invitations': post(posts) }) });
    const user = userEvent.setup();
    const dialog = await openWizard(user);
    await user.type(within(dialog).getByLabelText('Emails'), 'not-an-email,');
    await next(user, dialog);
    expect(await within(dialog).findByText('Enter valid email addresses.')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Remove not-an-email' }));
    await user.type(within(dialog).getByLabelText('Emails'), 'ok@example.test,');
    await next(user, dialog);
    await next(user, dialog);
    expect(await within(dialog).findByText('Choose at least one role.')).toBeInTheDocument();
    expect(posts).toEqual([]);
  });

  it('offers Developer access only when the API says developers are available', async () => {
    const available = (value: boolean) => ({
      '/api/v1/orgs/o1/developers': () =>
        json({ items: [], nextCursor: null, limit: 5, available: value }),
    });
    const off = await renderMembers({ handlers: handlers(available(false)) });
    const user = userEvent.setup();
    const closed = await openWizard(user);
    await user.type(within(closed).getByLabelText('Emails'), 'dev@example.test,');
    await next(user, closed);
    expect(within(closed).queryByRole('checkbox', { name: 'Developer access' })).toBeNull();
    off.unmount();

    const posts: { path: string; body: unknown }[] = [];
    await renderMembers({
      handlers: handlers({
        ...available(true),
        '/api/v1/orgs/o1/developer-invitations': (_url: URL, init?: RequestInit) => {
          posts.push({ path: 'developer', body: JSON.parse(String(init?.body)) });
          return json(invitation({ email: 'dev@example.test', roles: [] }), 201);
        },
      }),
    });
    const dialog = await openWizard(user);
    await user.type(within(dialog).getByLabelText('Emails'), 'dev@example.test,');
    await next(user, dialog);
    await user.click(await within(dialog).findByRole('checkbox', { name: 'Developer access' }));
    await next(user, dialog);
    await user.click(within(dialog).getByRole('button', { name: 'Send invitation' }));
    await waitFor(() =>
      expect(posts).toEqual([{ path: 'developer', body: { email: 'dev@example.test' } }]),
    );
  });

  it('stays on Review with the reason when every address is refused', async () => {
    await renderMembers({
      handlers: handlers({
        '/api/v1/orgs/o1/invitations': (_url, init) =>
          init?.method === 'POST'
            ? problem(503, 'unavailable', 'private server detail')
            : json({ items: [], nextCursor: null }),
      }),
    });
    const user = userEvent.setup();
    const dialog = await openWizard(user);
    await user.type(within(dialog).getByLabelText('Emails'), 'new@example.test,');
    await next(user, dialog);
    await user.click(within(dialog).getByRole('checkbox', { name: 'Integration admin' }));
    await next(user, dialog);
    await user.click(within(dialog).getByRole('button', { name: 'Send invitation' }));
    expect(
      await within(dialog).findByText('new@example.test: Something went wrong. Try again.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/private server detail/)).toBeNull();
  });

  it('drops a late answer after the signed-in person changes', async () => {
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
    const dialog = await openWizard(user);
    await user.type(within(dialog).getByLabelText('Emails'), 'new@example.test,');
    await next(user, dialog);
    await user.click(within(dialog).getByRole('checkbox', { name: 'Read only' }));
    await next(user, dialog);
    await user.click(within(dialog).getByRole('button', { name: 'Send invitation' }));
    const changed = sessionFixture('admin');
    if (!changed.authenticated) throw new Error('Expected an authenticated fixture.');
    currentUser = 'u2';
    act(() => {
      const updated: typeof changed = { ...changed, user: { ...changed.user, id: 'u2' } };
      queryClient.setQueryData(sessionQuery.queryKey, updated);
      queryClient.setQueryData(membershipsQuery.queryKey, {
        items: [membershipFixture('o1', { userId: 'u2' })],
      });
    });
    await act(async () => {
      resolve(json(invitation({ email: 'new@example.test' }), 201));
    });
    expect(screen.queryByText('Invitation sent to n•••@example.test.')).toBeNull();
  });
});
