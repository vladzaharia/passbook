import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { resetModeForTests } from '@/web/lib/mode.ts';
import { json, membershipFixture, renderApp } from '@/web/lib/test-utils.tsx';
import { managedSession } from './sessions/test-fixtures.ts';

afterEach(() => resetModeForTests());

const empty = () => json({ items: [], nextCursor: null });
const handlers = {
  '/api/v1/scanning-sessions': empty,
  '/api/v1/scan-setups': empty,
  '/api/v1/scan-events': empty,
  '/api/v1/scan-staff': empty,
  '/api/v1/scan-zones': empty,
  '/api/v1/templates/eligible': empty,
};
const org = {
  session: 'admin' as const,
  selectedOrg: 'o1',
  memberships: [membershipFixture('o1', { orgName: 'Northwind', orgSlug: 'northwind' })],
};

// With nothing set up the tab strip goes once the lists have loaded.
const settled = () => waitFor(() => expect(screen.queryByRole('tablist')).toBeNull());

describe('Scanning with nothing set up', () => {
  it('offers the three setups and Start blank, and no checklist', async () => {
    const user = userEvent.setup();
    await renderApp('/admin/o/o1/scanning', { ...org, handlers });
    await settled();
    expect(await screen.findByRole('heading', { name: 'Set up scanning' })).toBeInTheDocument();
    for (const name of [/Front desk/, /Event night/, /Several areas/])
      expect(screen.getByRole('link', { name })).toHaveAttribute(
        'href',
        expect.stringContaining('/scanning/setup?preset='),
      );
    expect(screen.queryByText('Set up a door')).toBeNull();
    expect(screen.queryByText('Create a session')).toBeNull();
    // Start blank is today's New session.
    await user.click(screen.getByRole('button', { name: 'Start blank' }));
    expect(await screen.findByRole('dialog', { name: 'New session' })).toBeInTheDocument();
  });

  it("opens the wizard with the tile's answers", async () => {
    const user = userEvent.setup();
    await renderApp('/admin/o/o1/scanning', { ...org, handlers });
    await settled();
    await user.click(await screen.findByRole('link', { name: /Event night/ }));
    expect(await screen.findByRole('textbox', { name: /Door name/ })).toHaveValue('Doors');
  });

  it('makes Set up scanning the header action once sessions exist', async () => {
    await renderApp('/admin/o/o1/scanning', {
      ...org,
      handlers: {
        ...handlers,
        '/api/v1/scanning-sessions': () => json({ items: [managedSession], nextCursor: null }),
      },
    });
    expect(await screen.findByRole('link', { name: 'Set up scanning' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Event night/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'New session' })).toBeInTheDocument();
  });

  it('shows a read-only member no setup', async () => {
    await renderApp('/admin/o/o1/scanning', {
      ...org,
      memberships: [
        membershipFixture('o1', {
          orgName: 'Northwind',
          orgSlug: 'northwind',
          capabilities: ['org:read', 'scanning:read'],
        }),
      ],
      handlers,
    });
    await settled();
    expect(await screen.findByText('No scanning sessions')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Front desk/ })).toBeNull();
  });
});
