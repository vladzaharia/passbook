import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { resetModeForTests, setMode, setTestOnlyOrgs } from '../../lib/mode.ts';
import { json, membershipFixture, renderApp } from '../../lib/test-utils.tsx';
import { connectionDetail, ORG } from '../passes/test-fixtures.ts';

const membership = membershipFixture(ORG.id, { orgName: ORG.name, orgSlug: ORG.slug });
const sandbox = { ...membership, testOnly: true };
const handlers = {
  '/api/v1/orgs': () => json({ items: [ORG], nextCursor: null }),
  '/api/v1/connections': () => json({ items: [], nextCursor: null }),
  '/api/v1/connections/c1': () => json(connectionDetail({ id: 'c1' })),
};
const SAY = 'Connections run in Live.';

afterEach(() => {
  resetModeForTests();
  setTestOnlyOrgs([]);
});

describe('Connections in Test mode', () => {
  it('says Connections run in Live on the list, and Switch to Live brings the list back', async () => {
    setMode('test');
    const user = userEvent.setup();
    await renderApp('/admin/connections', {
      session: 'admin',
      memberships: [membership],
      selectedOrg: ORG.id,
      handlers,
    });
    expect(await screen.findByText(SAY)).toBeInTheDocument();
    expect(screen.queryByText('Connection not found')).toBeNull();
    // Webhook endpoints do have a Test environment: their tab stays.
    expect(screen.getByRole('tab', { name: 'Webhook endpoints' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Switch to Live' }));
    await waitFor(() => expect(screen.queryByText(SAY)).toBeNull());
    expect(
      await screen.findByRole('heading', { name: 'Connections', level: 1 }),
    ).toBeInTheDocument();
  });

  it('says it on a connection URL and the new page too', async () => {
    setMode('test');
    for (const path of ['/connections/c1', '/connections/new']) {
      const { unmount } = await renderApp(`/admin/o/${ORG.id}${path}`, {
        session: 'admin',
        memberships: [membership],
        handlers,
      });
      expect(await screen.findByText(SAY)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Switch to Live' })).toBeInTheDocument();
      unmount();
    }
  });
});

describe('Connections in a developer sandbox', () => {
  it('hides Connections from the nav and the palette', async () => {
    const user = userEvent.setup();
    await renderApp(`/admin/o/${ORG.id}/passes`, {
      session: 'admin',
      memberships: [sandbox],
      handlers: { ...handlers, '/api/v1/passes': () => json({ items: [], nextCursor: null }) },
    });
    const nav = await screen.findByRole('navigation', { name: 'Admin' });
    expect(await within(nav).findByRole('link', { name: 'Passes' })).toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: 'Connections' })).toBeNull();
    await user.keyboard('{Control>}k{/Control}');
    const input = await screen.findByRole('combobox', { name: 'Search' });
    await user.type(input, 'connection');
    expect(screen.queryByRole('option', { name: /Connections/ })).toBeNull();
    expect(screen.queryByRole('option', { name: 'New connection' })).toBeNull();
  });

  it('shows the same state at a direct URL, with no way to Live, and keeps the webhook tab', async () => {
    for (const path of ['/connections/c1', '/connections']) {
      const { unmount } = await renderApp(`/admin/o/${ORG.id}${path}`, {
        session: 'admin',
        memberships: [sandbox],
        handlers,
      });
      expect(await screen.findByText(SAY)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Switch to Live' })).toBeNull();
      unmount();
    }
  });
});
