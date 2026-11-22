import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { json, membershipFixture, renderApp } from '../../lib/test-utils.tsx';
import { CONNECTOR, connectionDetail, ORG } from '../passes/test-fixtures.ts';

const membership = membershipFixture(ORG.id, { orgName: ORG.name, orgSlug: ORG.slug });
const run = (n: number) => ({
  id: `r${n}`,
  trigger: 'schedule',
  startedAt: 1_700_000_000_000 - n * 60_000,
  finishedAt: 1_700_000_001_000 - n * 60_000,
  outcome: n === 0 ? 'changed' : 'unchanged',
  recordsSeen: 3,
  passesChanged: 0,
  passesCreated: null,
  passesVoided: null,
  recordsFailed: null,
  errorCode: null,
  httpStatus: 200,
  durationMs: 100,
});

describe('connection health', () => {
  const open = (runs: unknown[]) =>
    renderApp('/admin/connections/c1', {
      session: 'admin',
      memberships: [membership],
      selectedOrg: ORG.id,
      handlers: {
        '/api/v1/orgs': () => json({ items: [ORG], nextCursor: null }),
        '/api/v1/connectors/http-json': () => json(CONNECTOR),
        '/api/v1/connections/c1': () => json(connectionDetail({ runs })),
      },
    });

  it('names the run colours and shows five runs until Show all', async () => {
    const user = userEvent.setup();
    await open(Array.from({ length: 8 }, (_, i) => run(i)));
    const legend = await screen.findByRole('list', { name: 'Legend' });
    expect(within(legend).getByText('Changed')).toBeVisible();
    expect(within(legend).getByText('Failed')).toBeVisible();
    expect(within(legend).getByText(/Unchanged/)).toBeVisible();
    expect(within(legend).getByText(/ran, nothing to update/)).toBeVisible();
    const table = screen.getByRole('table', { name: 'Connection runs' });
    expect(within(table).getAllByRole('row')).toHaveLength(1 + 5);
    await user.click(screen.getByRole('button', { name: 'Show all 8' }));
    expect(within(table).getAllByRole('row')).toHaveLength(1 + 8);
    await user.click(screen.getByRole('button', { name: 'Show fewer' }));
    expect(within(table).getAllByRole('row')).toHaveLength(1 + 5);
  });

  it('has no Show all for a short history', async () => {
    await open([run(0), run(1)]);
    await screen.findByRole('table', { name: 'Connection runs' });
    expect(screen.queryByRole('button', { name: /^Show all/ })).toBeNull();
  });

  it('calls the lifecycle tab Lifecycle', async () => {
    await open([run(0)]);
    expect(await screen.findByRole('tab', { name: 'Lifecycle' })).toBeVisible();
    expect(screen.queryByRole('tab', { name: 'Settings' })).toBeNull();
  });
});
