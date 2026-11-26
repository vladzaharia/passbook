import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { json, membershipFixture, problem, renderApp } from '@/web/lib/test-utils.tsx';
import { ACTIVE_ZONES, annex, gym } from './test-fixtures.ts';

const northwind = membershipFixture('o1', { orgName: 'Northwind', orgSlug: 'northwind' });
const empty = () => json({ items: [], nextCursor: null });

function setup(over: { active?: unknown[]; archived?: unknown[] } = {}) {
  const calls: { path: string; method: string; body?: unknown }[] = [];
  const handlers = {
    '/api/v1/scanning-sessions': empty,
    '/api/v1/scan-setups': empty,
    '/api/v1/scan-zones': (url: URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        calls.push({ path: url.pathname, method: 'POST', body });
        return json({ ...gym, ...body, id: 'z-new', sessions: 0, plans: [], inNow: null }, 201);
      }
      return json({
        items:
          url.searchParams.get('archived') === 'true'
            ? (over.archived ?? [])
            : (over.active ?? ACTIVE_ZONES),
        nextCursor: null,
      });
    },
  } as Record<string, (url: URL, init?: RequestInit) => Response>;
  for (const z of [...ACTIVE_ZONES, annex]) {
    for (const verb of ['archive', 'restore']) {
      handlers[`/api/v1/scan-zones/${z.id}/${verb}`] = (url) => {
        calls.push({ path: url.pathname, method: 'POST' });
        return json({ ...z, archivedAt: verb === 'archive' ? 1 : null });
      };
    }
    handlers[`/api/v1/scan-zones/${z.id}`] = (url, init) => {
      calls.push({
        path: url.pathname,
        method: String(init?.method),
        body: JSON.parse(String(init?.body)),
      });
      return json(z);
    };
  }
  return { calls, handlers };
}
const open = (s: ReturnType<typeof setup>) =>
  renderApp('/admin/scanning?tab=zones&orgId=o1', {
    session: 'admin',
    memberships: [northwind],
    selectedOrg: 'o1',
    handlers: s.handlers,
  });

describe('Zones tab', () => {
  it('lists the zones as a tree with aria-level, parents before children', async () => {
    await open(setup());
    const list = await screen.findByRole('list', { name: 'Zones' });
    const rows = within(list).getAllByRole('listitem');
    expect(
      rows.map((r) => [
        r.getAttribute('aria-level'),
        within(r).getByText(/^(Gym|Pool|Sauna|Lobby)$/).textContent,
      ]),
    ).toEqual([
      ['1', 'Gym'],
      ['2', 'Pool'],
      ['3', 'Sauna'],
      ['1', 'Lobby'],
    ]);
    expect(within(rows[0] as HTMLElement).getByText('Tap out required')).toBeInTheDocument();
    expect(within(rows[0] as HTMLElement).getByText('42 / 60 inside')).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText('Tracks headcount')).toBeInTheDocument();
  });

  it('confirms an archive with what depends on the zone, then archives', async () => {
    const s = setup();
    await open(s);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Actions for Gym' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Archive' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Archive Gym?' });
    expect(dialog).toHaveTextContent('2 sessions check it; 2 plans grant it.');
    expect(dialog).toHaveTextContent('2 zones inside it archive too.');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(s.calls).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Actions for Gym' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Archive' }));
    await user.click(await screen.findByRole('button', { name: 'Archive' }));
    await waitFor(() =>
      expect(s.calls).toEqual([{ path: '/api/v1/scan-zones/z-gym/archive', method: 'POST' }]),
    );
  });

  it('restores an archived zone from behind Show archived', async () => {
    const s = setup({ archived: [annex] });
    await open(s);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Show archived (1)' }));
    const list = await screen.findByRole('list', { name: 'Archived zones' });
    await user.click(within(list).getByRole('button', { name: 'Restore' }));
    await waitFor(() =>
      expect(s.calls).toEqual([{ path: '/api/v1/scan-zones/z-annex/restore', method: 'POST' }]),
    );
  });

  it('creates a zone: key follows the name, occupancy limits wait for Track', async () => {
    const s = setup();
    await open(s);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New zone' }));
    const dialog = await screen.findByRole('dialog', { name: 'New zone' });
    await user.type(within(dialog).getByRole('textbox', { name: /^Name/ }), 'Front Gate 2');
    expect(within(dialog).getByRole('textbox', { name: /^Key/ })).toHaveValue('front-gate-2');
    expect(within(dialog).queryByRole('spinbutton', { name: 'Capacity' })).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Next' }));
    await user.click(await within(dialog).findByRole('switch', { name: 'Track who’s inside' }));
    expect(within(dialog).getByRole('spinbutton', { name: 'Max stay' })).toHaveValue(720);
    await user.type(within(dialog).getByRole('spinbutton', { name: 'Capacity' }), '40');
    await user.click(within(dialog).getByRole('button', { name: 'Next' }));
    expect(await within(dialog).findByRole('heading', { name: 'Check and create' })).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Create zone' }));
    await waitFor(() => expect(s.calls).toHaveLength(1));
    expect(s.calls[0]?.body).toEqual({
      orgId: 'o1',
      key: 'front-gate-2',
      name: 'Front Gate 2',
      parentId: null,
      timeZone: null,
      occupancy: 'track',
      capacity: 40,
      hardLimit: false,
      maxStayMinutes: 720,
      clearAt: null,
    });
  });

  it('Hard limit waits for a capacity, goes with it, and is sent when on', async () => {
    const s = setup();
    await open(s);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New zone' }));
    const dialog = await screen.findByRole('dialog', { name: 'New zone' });
    await user.type(within(dialog).getByRole('textbox', { name: /^Name/ }), 'Vessel');
    await user.click(within(dialog).getByRole('button', { name: 'Next' }));
    await user.click(await within(dialog).findByRole('switch', { name: 'Track who’s inside' }));
    const hard = within(dialog).getByRole('switch', { name: 'Hard limit' });
    expect(hard).toBeDisabled();
    const capacity = within(dialog).getByRole('spinbutton', { name: 'Capacity' });
    await user.type(capacity, '90');
    expect(hard).toBeEnabled();
    await user.click(hard);
    await user.clear(capacity);
    expect(hard).toBeDisabled();
    expect(hard).not.toBeChecked();
    await user.type(capacity, '90');
    await user.click(hard);
    await user.click(within(dialog).getByRole('button', { name: 'Next' }));
    await user.click(await within(dialog).findByRole('button', { name: 'Create zone' }));
    await waitFor(() => expect(s.calls).toHaveLength(1));
    expect(s.calls[0]?.body).toMatchObject({ capacity: 90, hardLimit: true });
  });

  it('holds Next on an empty name and says why', async () => {
    await open(setup());
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New zone' }));
    const dialog = await screen.findByRole('dialog', { name: 'New zone' });
    const next = within(dialog).getByRole('button', { name: 'Next' });
    expect(next).toHaveAttribute('aria-disabled', 'true');
    await user.click(next);
    expect(await within(dialog).findByText('Required.')).toBeInTheDocument();
    expect(within(dialog).queryByRole('heading', { name: 'Track who is inside' })).toBeNull();
  });

  it('edits from the rail, holds Save until something changes, and sends the change', async () => {
    const s = setup();
    await open(s);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Actions for Gym' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit Gym' });
    const save = within(dialog).getByRole('button', { name: 'Save' });
    expect(save).toHaveAttribute('aria-disabled', 'true');
    expect(within(dialog).getByText('No changes.')).toBeInTheDocument();
    expect(within(dialog).queryByRole('heading', { name: 'Check and create' })).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: /^Occupancy/ }));
    const capacity = await within(dialog).findByRole('spinbutton', { name: 'Capacity' });
    await user.clear(capacity);
    await user.type(capacity, '80');
    await user.click(within(dialog).getByRole('button', { name: /^Zone/ }));
    expect(within(dialog).getByRole('textbox', { name: /^Key/ })).toHaveAttribute('readonly');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(s.calls).toHaveLength(1));
    expect(s.calls[0]).toMatchObject({
      path: '/api/v1/scan-zones/z-gym',
      method: 'PATCH',
      body: { name: 'Gym', capacity: 80 },
    });
  });

  it('hides who is inside and Mark as out while the console has no route for them', async () => {
    await open(setup());
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Actions for Gym' }));
    expect(await screen.findByRole('menuitem', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /^Who’s inside/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Mark as out')).not.toBeInTheDocument();
  });

  it('says so when the server has no zones route', async () => {
    const s = setup();
    s.handlers['/api/v1/scan-zones'] = () => problem(404, 'not_found', 'Not found.');
    await open(s);
    expect(await screen.findByText('Zones are unavailable')).toBeInTheDocument();
  });
});
