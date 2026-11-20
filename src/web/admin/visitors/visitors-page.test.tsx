import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Visitor } from '@/shared/contracts/visitors.ts';
import {
  type FetchHandler,
  json,
  membershipFixture,
  problem,
  renderApp,
} from '@/web/lib/test-utils.tsx';

const NOW = Date.now();
const visitor = (over: Partial<Visitor>): Visitor => ({
  id: 'v1',
  passId: 'p1',
  name: 'Leo Park',
  hostName: 'Ana Ruiz',
  windowFrom: NOW,
  windowUntil: NOW + 8 * 3_600_000,
  note: null,
  status: 'expected',
  statusAt: null,
  autoOut: false,
  hasEmail: true,
  ...over,
});
const northwind = membershipFixture('o1', { orgName: 'Northwind', orgSlug: 'northwind' });
const callsTo = (m: { mock: { calls: unknown[][] } }, method: string, suffix: string) =>
  m.mock.calls.filter(
    ([u, init]) =>
      String(u).split('?')[0]?.endsWith(suffix) &&
      ((init as RequestInit | undefined)?.method ?? 'GET') === method,
  );

function open(items: Visitor[], extra: Record<string, FetchHandler> = {}, path = '') {
  return renderApp(`/admin/o/o1/visitors${path}`, {
    session: 'admin',
    memberships: [northwind],
    selectedOrg: 'o1',
    handlers: { '/api/v1/visitors': () => json({ items }), ...extra },
  });
}

afterEach(() => vi.restoreAllMocks());

describe('Visitors page', () => {
  it('lists a day with host, window and a status for each state', async () => {
    const { fetchMock } = await open([
      visitor({}),
      visitor({ id: 'v2', name: 'Mia Stone', status: 'in', statusAt: NOW }),
      visitor({ id: 'v3', name: 'Sam Lee', status: 'out', statusAt: NOW }),
      visitor({ id: 'v4', name: 'Kim Hu', status: 'no_show' }),
    ]);
    const table = await screen.findByRole('table', { name: 'Visitors' });
    for (const name of ['Leo Park', 'Mia Stone', 'Sam Lee', 'Kim Hu'])
      expect(within(table).getByText(name)).toBeInTheDocument();
    expect(within(table).getByText('Expected')).toBeInTheDocument();
    expect(within(table).getByText(/Checked in/)).toBeInTheDocument();
    expect(within(table).getByText(/Checked out/)).toBeInTheDocument();
    expect(within(table).getByText('No-show')).toBeInTheDocument();
    const [list] = callsTo(fetchMock, 'GET', '/visitors');
    const q = new URL(String(list?.[0]), 'http://x').searchParams;
    expect(q.get('orgId')).toBe('o1');
    expect(q.get('tab')).toBe('today');
  });

  it('asks the server for the tab chosen in the URL and shows its empty state', async () => {
    const { fetchMock } = await open([], {}, '?tab=upcoming');
    expect(await screen.findByText('No visitors coming')).toBeInTheDocument();
    const urls = callsTo(fetchMock, 'GET', '/visitors').map(
      ([u]) => new URL(String(u), 'http://x').searchParams,
    );
    expect(urls.some((q) => q.get('tab') === 'upcoming')).toBe(true);
  });

  it('checks a visitor out from the row menu', async () => {
    const user = userEvent.setup();
    const { fetchMock } = await open([visitor({ status: 'in', statusAt: NOW })], {
      '/api/v1/visitors/v1/check-out': () => json(visitor({ status: 'out', statusAt: NOW })),
    });
    await user.click(await screen.findByRole('button', { name: 'Actions for Leo Park' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Check out' }));
    await waitFor(() => expect(callsTo(fetchMock, 'POST', '/check-out')).toHaveLength(1));
    expect(await screen.findByText('Checked out')).toBeInTheDocument();
  });

  it('cancels a visit only after a confirm', async () => {
    const user = userEvent.setup();
    const { fetchMock } = await open([visitor({})], {
      '/api/v1/visitors/v1/cancel': () => json(visitor({ status: 'cancelled' })),
    });
    await user.click(await screen.findByRole('button', { name: 'Actions for Leo Park' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Cancel visit' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(callsTo(fetchMock, 'POST', '/cancel')).toHaveLength(0);
    await user.click(within(confirm).getByRole('button', { name: 'Cancel visit' }));
    await waitFor(() => expect(callsTo(fetchMock, 'POST', '/cancel')).toHaveLength(1));
  });

  it('invites a visitor with a host and sends the window as local times', async () => {
    const user = userEvent.setup();
    const { fetchMock } = await open([], {
      '/api/v1/visitors': (_url, init) =>
        init?.method === 'POST' ? json(visitor({ name: 'Leo Park' }), 201) : json({ items: [] }),
    });
    await user.click(await screen.findByRole('button', { name: 'New visitor' }));
    const dialog = await screen.findByRole('dialog', { name: 'New visitor' });
    await user.click(within(dialog).getByRole('button', { name: 'Invite' }));
    expect(await within(dialog).findAllByText('Required.')).toHaveLength(3);
    await user.type(within(dialog).getByLabelText(/^Name/), 'Leo Park');
    await user.type(within(dialog).getByLabelText(/^Host(?! email)/), 'Ana Ruiz');
    await user.type(within(dialog).getByLabelText(/^Host email/), 'ana@host.test');
    await user.click(within(dialog).getByRole('button', { name: 'Invite' }));
    await waitFor(() => expect(callsTo(fetchMock, 'POST', '/visitors')).toHaveLength(1));
    const [, init] = callsTo(fetchMock, 'POST', '/visitors')[0] ?? [];
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body).toMatchObject({
      orgId: 'o1',
      name: 'Leo Park',
      hostName: 'Ana Ruiz',
      hostEmail: 'ana@host.test',
    });
    expect(body.windowUntil - body.windowFrom).toBe(8 * 3_600_000);
    expect(body).not.toHaveProperty('email');
  });

  it('shows the missing template as a sentence in the form', async () => {
    const user = userEvent.setup();
    await open([], {
      '/api/v1/visitors': (_url, init) =>
        init?.method === 'POST'
          ? problem(409, 'VISITOR_TEMPLATE_MISSING', 'Make a guest pass template first.')
          : json({ items: [] }),
    });
    await user.click(await screen.findByRole('button', { name: 'New visitor' }));
    const dialog = await screen.findByRole('dialog', { name: 'New visitor' });
    await user.type(within(dialog).getByLabelText(/^Name/), 'Leo Park');
    await user.type(within(dialog).getByLabelText(/^Host(?! email)/), 'Ana Ruiz');
    await user.type(within(dialog).getByLabelText(/^Host email/), 'ana@host.test');
    await user.click(within(dialog).getByRole('button', { name: 'Invite' }));
    expect(
      await within(dialog).findByText('Make a guest pass template first.'),
    ).toBeInTheDocument();
  });

  it('lets the inviter pick the host from the members, with typing as the other choice', async () => {
    const user = userEvent.setup();
    const { fetchMock } = await open([], {
      '/api/v1/visitors/hosts': () =>
        json({ items: [{ id: 'u9', name: 'Ana Ruiz', email: 'ana@northwind.test' }] }),
      '/api/v1/visitors': (_url, init) =>
        init?.method === 'POST' ? json(visitor({}), 201) : json({ items: [] }),
    });
    await user.click(await screen.findByRole('button', { name: 'New visitor' }));
    const dialog = await screen.findByRole('dialog', { name: 'New visitor' });
    await user.type(within(dialog).getByLabelText(/^Name/), 'Leo Park');
    expect(within(dialog).queryByLabelText(/^Host email/)).toBeNull();
    await user.click(await within(dialog).findByRole('combobox', { name: /^Host/ }));
    await user.click(await screen.findByRole('option', { name: /Ana Ruiz/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Invite' }));
    await waitFor(() => expect(callsTo(fetchMock, 'POST', '/visitors')).toHaveLength(1));
    const [, init] = callsTo(fetchMock, 'POST', '/visitors')[0] ?? [];
    const sent = JSON.parse(String((init as RequestInit).body));
    expect(sent).toMatchObject({ hostUserId: 'u9' });
    expect(sent).not.toHaveProperty('hostEmail');
  });
});
