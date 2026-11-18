import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { json, membershipFixture, renderApp } from '@/web/lib/test-utils.tsx';
import { checkedAtLine, checkedAtNames } from './checked-at.ts';
import { ACTIVE_ZONES, gym, lobby, pool } from './test-fixtures.ts';

const northwind = membershipFixture('o1', { orgName: 'Northwind', orgSlug: 'northwind' });
const empty = () => json({ items: [], nextCursor: null });

describe('checked at', () => {
  it('lists each session once, by name', () => {
    expect(checkedAtNames([gym, pool, { checkedAt: [{ id: 's-desk', name: 'Desk' }] }])).toEqual([
      'Desk',
      'Front door',
      'Pool gate',
    ]);
    expect(checkedAtLine(checkedAtNames([gym]))).toBe('Checked at Desk, Front door');
    expect(checkedAtLine([])).toBe('Not checked anywhere');
  });

  it('shows on each Zones tab row the sessions that check the zone', async () => {
    await renderApp('/admin/scanning?tab=zones&orgId=o1', {
      session: 'admin',
      memberships: [northwind],
      selectedOrg: 'o1',
      handlers: {
        '/api/v1/scanning-sessions': empty,
        '/api/v1/scan-setups': empty,
        '/api/v1/scan-zones': () => json({ items: ACTIVE_ZONES, nextCursor: null }),
      },
    });
    const list = await screen.findByRole('list', { name: 'Zones' });
    const row = (name: string) =>
      within(list)
        .getAllByRole('listitem')
        .find((li) => li.textContent?.startsWith(name)) as HTMLElement;
    expect(row(gym.name)).toHaveTextContent('Checked at Desk, Front door');
    expect(row(pool.name)).toHaveTextContent('Checked at Pool gate');
    expect(row(lobby.name)).toHaveTextContent('Not checked anywhere');
  });
});
