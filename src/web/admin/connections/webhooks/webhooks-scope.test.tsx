import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { resetModeForTests } from '../../../lib/mode.ts';
import { membershipFixture, renderApp } from '../../../lib/test-utils.tsx';
import { type Calls, endpoint, hooks, manager } from './test-fixtures.ts';

afterEach(() => resetModeForTests());

const harbor = membershipFixture('org2', { orgName: 'Harbor', orgSlug: 'harbor' });

// The organization comes from the path; a page never waits on a missing one.
describe('webhook endpoint page scope', () => {
  it('loads from the organization in the path, with no ?orgId=', async () => {
    const calls: Calls[] = [];
    const { router } = await renderApp(`/admin/o/${manager.orgId}/connections/webhooks/we1`, {
      session: 'admin',
      memberships: [manager, harbor],
      handlers: hooks(calls),
    });
    expect(await screen.findByRole('textbox', { name: /Description/ })).toBeInTheDocument();
    expect(router.state.location.search).not.toHaveProperty('orgId');
    expect(screen.queryByText('Loading webhook')).toBeNull();
  });

  it('opens an old link without ?orgId= in its organization', async () => {
    const calls: Calls[] = [];
    const { router } = await renderApp('/admin/connections/webhooks/we1', {
      session: 'admin',
      memberships: [harbor, manager],
      handlers: hooks(calls),
    });
    expect(await screen.findByRole('textbox', { name: /Description/ })).toBeInTheDocument();
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(
        `/admin/o/${manager.orgId}/connections/webhooks/we1`,
      ),
    );
  });

  it('says not found, not loading, when the path names another organization', async () => {
    const calls: Calls[] = [];
    await renderApp('/admin/o/org2/connections/webhooks/we1', {
      session: 'admin',
      memberships: [manager, harbor],
      handlers: hooks(calls, { endpoints: [endpoint()] }),
    });
    expect(await screen.findByText('Webhook not found')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /Description/ })).toBeNull();
  });

  it('refuses an organization the principal is not a member of, without loading', async () => {
    const calls: Calls[] = [];
    await renderApp('/admin/o/org9/connections/webhooks/we1', {
      session: 'admin',
      memberships: [manager],
      handlers: hooks(calls),
    });
    expect(
      await screen.findByText('You are not a member of this organization.'),
    ).toBeInTheDocument();
    expect(calls.some((c) => c.path.startsWith('/api/v1/webhook-endpoints'))).toBe(false);
  });
});
