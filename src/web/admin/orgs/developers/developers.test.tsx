import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { json } from '@/web/lib/test-utils.tsx';
import { handlers, member, renderMembers } from '../org-access-fixtures.ts';

const dev = {
  userId: 'u9',
  name: 'Dev Dana',
  email: 'dana@example.test',
  since: 1_700_000_000_000,
  roles: null,
};
const invite = {
  id: 'di1',
  orgId: 'o1',
  email: 'wait@example.test',
  roles: [],
  state: 'pending',
  createdAt: 1_700_000_000_000,
  expiresAt: 4_000_000_000_000,
  revokedAt: null,
};
const devApi = (available: boolean) => ({
  '/api/v1/orgs/o1/developers': () =>
    json({ items: available ? [dev] : [], nextCursor: null, limit: 5, available }),
  '/api/v1/orgs/o1/developer-invitations': () => json({ items: [invite], nextCursor: null }),
});

describe('Members: Developers', () => {
  it('is hidden when developers are not available', async () => {
    await renderMembers({ handlers: handlers(devApi(false)) });
    expect(await screen.findByRole('heading', { name: 'Members' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Developers' })).toBeNull();
  });

  it('lists developers and pending invitations, and removes one after a confirm', async () => {
    const deletes: string[] = [];
    await renderMembers({
      handlers: handlers({
        ...devApi(true),
        '/api/v1/orgs/o1/developers/u9': (_u, init) => {
          deletes.push(String(init?.method));
          return json({ ok: true });
        },
      }),
    });
    const ui = userEvent.setup();
    expect(await screen.findByText('Dev Dana')).toBeInTheDocument();
    expect(await screen.findByText('wait@example.test')).toBeInTheDocument();
    await ui.click(screen.getByRole('button', { name: 'Remove' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Their developer access ends.')).toBeInTheDocument();
    await ui.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(deletes).toEqual(['DELETE']));
  });
});

describe('Members: Access paused', () => {
  it('flags a member whose console access is paused', async () => {
    await renderMembers({
      handlers: handlers({
        '/api/v1/orgs/o1/memberships': () =>
          json({
            items: [
              member({ accessPaused: true }),
              member({
                id: 'member-2',
                userId: 'u3',
                userName: 'Grace',
                userEmail: 'grace@example.test',
              }),
            ],
            nextCursor: null,
          }),
      }),
    });
    expect(await screen.findAllByText('Access paused')).toHaveLength(1);
  });
});
