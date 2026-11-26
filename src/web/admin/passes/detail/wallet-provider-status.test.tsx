import { act, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { resetModeForTests } from '../../../lib/mode.ts';
import { membershipsQuery, sessionQuery } from '../../../lib/session.ts';
import {
  type FetchHandler,
  json,
  membershipFixture,
  problem,
  renderApp,
  sessionFixture,
} from '../../../lib/test-utils.tsx';
import { ORG, passDetail, passSummary, templateDetail, templateSummary } from '../test-fixtures.ts';

beforeEach(() => resetModeForTests());

const path = '/api/v1/wallet-providers/passes/p1';
const scope = {
  memberships: [membershipFixture(ORG.id, { orgName: ORG.name, orgSlug: ORG.slug })],
  selectedOrg: ORG.id,
};
const instance = (provider: 'google' | 'samsung', over: Record<string, unknown> = {}) => ({
  provider,
  lifecycle: 'absent',
  desiredOperation: null,
  priorGenerationRetirementPending: false,
  installation: 'unknown',
  issuance: { state: 'disabled', reason: 'not_released' },
  ...over,
});
const devices = () =>
  json({
    version: 3,
    removal: null,
    devices: [
      {
        device: 'a1b2c3d4e5f6',
        status: 'current',
        registeredAt: 1_700_000_000_000,
        unregisteredAt: null,
        lastFetch: null,
        lastPush: null,
        removal: null,
      },
    ],
  });
function handlers(extra: Record<string, FetchHandler> = {}) {
  return {
    '/api/v1/orgs': () => json({ items: [ORG], nextCursor: null }),
    '/api/v1/templates': () => json({ items: [templateSummary()], nextCursor: null }),
    '/api/v1/templates/tpl1': () => json(templateDetail()),
    '/api/v1/passes': () => json({ items: [passSummary()], nextCursor: null }),
    '/api/v1/passes/p1': () => json(passDetail()),
    '/api/v1/passes/p1/assets': () => json({ items: [] }),
    '/api/v1/passes/p1/devices': devices,
    ...extra,
  };
}

describe('wallet provider instances', () => {
  it('shows absent and blocked current instances, pending prior retirement and unknown installation beside Apple', async () => {
    const { container } = await renderApp('/admin/passes/p1?tab=devices', {
      session: 'admin',
      ...scope,
      handlers: handlers({
        [path]: () =>
          json({
            credentialGeneration: 2,
            providers: [
              instance('google'),
              instance('samsung', { lifecycle: 'blocked', priorGenerationRetirementPending: true }),
            ],
          }),
      }),
    });
    const list = await screen.findByRole('list', { name: 'Wallet provider instances' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Google Wallet');
    expect(rows[0]).toHaveTextContent('Not offered');
    expect(rows[0]).toHaveTextContent('Not open to holders yet.');
    expect(rows[1]).toHaveTextContent('Samsung Wallet');
    expect(rows[1]).toHaveTextContent('A previous generation is still awaiting retirement');
    for (const row of rows) expect(row).not.toHaveTextContent('Installation on a device');
    expect(list).not.toHaveTextContent(/not configured/i);
    expect(
      within(screen.getByRole('list', { name: 'Devices' })).getAllByRole('listitem'),
    ).toHaveLength(1);
    expect((await axe(container)).violations).toEqual([]);
  });

  it('reports operation success as a local outcome, not a device installation or deletion', async () => {
    await renderApp('/admin/passes/p1?tab=devices', {
      session: 'admin',
      ...scope,
      handlers: handlers({
        [path]: () =>
          json({
            credentialGeneration: 1,
            providers: [
              instance('google', {
                issuance: { state: 'enabled' },
                lifecycle: 'active',
                desiredOperation: { version: 2, kind: 'upsert', state: 'succeeded', reason: 'ok' },
              }),
              instance('samsung', {
                issuance: { state: 'enabled' },
                lifecycle: 'revoked',
                desiredOperation: { version: 3, kind: 'revoke', state: 'succeeded', reason: 'ok' },
              }),
            ],
          }),
      }),
    });
    const rows = within(
      await screen.findByRole('list', { name: 'Wallet provider instances' }),
    ).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Up to date');
    expect(screen.getByText(/Update v2: Succeeded \(provider accepted\)/)).toBeInTheDocument();
    expect(rows[1]).toHaveTextContent('Closed');
    expect(screen.getByText(/Revocation v3: Succeeded \(provider accepted\)/)).toBeInTheDocument();
    for (const row of rows) expect(row).not.toHaveTextContent(/\b(installed|deleted)\b/i);
  });

  it('shows what the provider reported as a pill, without calling it proof', async () => {
    await renderApp('/admin/passes/p1?tab=devices', {
      session: 'admin',
      ...scope,
      handlers: handlers({
        [path]: () =>
          json({
            credentialGeneration: 1,
            providers: [
              instance('google', { lifecycle: 'active', reported: { event: 'saved', at: 5 } }),
              instance('samsung', { lifecycle: 'active', reported: { event: 'removed', at: 9 } }),
            ],
          }),
      }),
    });
    const rows = within(
      await screen.findByRole('list', { name: 'Wallet provider instances' }),
    ).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Saved by holder');
    expect(rows[1]).toHaveTextContent('Removed by holder');
    for (const row of rows) expect(row).toHaveTextContent('not proof of what is on a device');
  });

  it.each([
    ['ready', 'Ready', 'Prepared locally'],
    ['revoking', 'Closing', 'Revocation in progress'],
    ['retired', 'Closed', 'Retired locally'],
  ] as const)(
    'renders %s plainly with the local lifecycle under technical details',
    async (lifecycle, label, technical) => {
      await renderApp('/admin/passes/p1?tab=devices', {
        session: 'admin',
        ...scope,
        handlers: handlers({
          [path]: () =>
            json({
              credentialGeneration: 1,
              providers: [
                instance('google', { lifecycle, issuance: { state: 'enabled' } }),
                instance('samsung'),
              ],
            }),
        }),
      });
      const row = within(
        await screen.findByRole('list', { name: 'Wallet provider instances' }),
      ).getAllByRole('listitem')[0];
      expect(row).toHaveTextContent(label);
      expect(screen.getByText(new RegExp(technical))).toBeInTheDocument();
      expect(row).not.toHaveTextContent('Installation on a device');
    },
  );

  it('keeps Apple devices visible when provider status is unavailable, and vice versa', async () => {
    const first = await renderApp('/admin/passes/p1?tab=devices', {
      session: 'admin',
      ...scope,
      handlers: handlers({
        [path]: () => problem(503, 'unavailable', 'Try again.'),
      }),
    });
    expect(await screen.findByText('Could not load wallet status.')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Devices' })).toBeInTheDocument();
    first.unmount();
    await renderApp('/admin/passes/p1?tab=devices', {
      session: 'admin',
      ...scope,
      handlers: handlers({
        '/api/v1/passes/p1/devices': () => problem(503, 'unavailable', 'Try again.'),
        [path]: () =>
          json({ credentialGeneration: 1, providers: [instance('google'), instance('samsung')] }),
      }),
    });
    expect(
      await screen.findByRole('list', { name: 'Wallet provider instances' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('does not request status in a different mode', async () => {
    let requests = 0;
    await renderApp('/admin/passes/p1?tab=devices', {
      session: 'admin',
      ...scope,
      handlers: handlers({
        '/api/v1/passes/p1': () => json(passDetail({ mode: 'test' })),
        [path]: () => {
          requests++;
          return json({
            credentialGeneration: 1,
            providers: [instance('google'), instance('samsung')],
          });
        },
      }),
    });
    expect(
      await screen.findByText('Switch to Test mode to view wallet status.'),
    ).toBeInTheDocument();
    expect(requests).toBe(0);
  });

  it('reads once for the Wallets card while another tab is active, and shows nothing for unreleased providers', async () => {
    let requests = 0;
    await renderApp('/admin/passes/p1?tab=fields', {
      session: 'admin',
      ...scope,
      handlers: handlers({
        [path]: () => {
          requests++;
          return json({
            credentialGeneration: 1,
            providers: [instance('google'), instance('samsung')],
          });
        },
      }),
    });
    expect(await screen.findByRole('tab', { name: 'Fields' })).toBeInTheDocument();
    await waitFor(() => expect(requests).toBe(1));
    expect(screen.queryByRole('list', { name: 'Wallets' })).not.toBeInTheDocument();
  });

  it('shows Not saved, Offered and Recommended on the pass page for released providers', async () => {
    const enabled = { state: 'enabled' as const };
    await renderApp('/admin/passes/p1?tab=fields', {
      session: 'admin',
      ...scope,
      handlers: handlers({
        [path]: () =>
          json({
            credentialGeneration: 1,
            providers: [
              instance('google', { lifecycle: 'active', issuance: enabled }),
              instance('samsung', { issuance: enabled }),
            ],
          }),
      }),
    });
    const list = await screen.findByRole('list', { name: 'Wallets' });
    expect(within(list).getByText('Offered')).toBeInTheDocument();
    expect(within(list).getByText('Not saved')).toBeInTheDocument();
    expect(within(list).getAllByText('Recommended')).toHaveLength(1);
  });

  it('hides status when the current membership loses passes:read', async () => {
    const { queryClient } = await renderApp('/admin/passes/p1?tab=devices', {
      session: 'admin',
      ...scope,
      handlers: handlers({
        [path]: () =>
          json({
            credentialGeneration: 1,
            providers: [instance('google', { lifecycle: 'active' }), instance('samsung')],
          }),
      }),
    });
    expect(await screen.findByText(/Active locally/)).toBeInTheDocument();
    act(() => {
      queryClient.setQueryData(membershipsQuery.queryKey, {
        items: [membershipFixture(ORG.id, { capabilities: ['integrations:read'] })],
      });
    });
    await waitFor(() => expect(screen.queryByText(/Active locally/)).toBeNull());
  });

  it('does not reuse a prior principal’s status after the principal changes', async () => {
    let principal = 'u1';
    // The web test target is ES2023 and does not expose Promise.withResolvers.
    let finish!: (response: Response) => void;
    const delayed = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const { queryClient } = await renderApp('/admin/passes/p1?tab=devices', {
      session: 'admin',
      ...scope,
      handlers: handlers({
        // The server answers for whoever is signed in, so refetches agree with the cache.
        '/api/v1/session': () => {
          const session = sessionFixture('admin');
          if (!session.authenticated) throw new Error('Expected a signed-in fixture');
          return json({ ...session, user: { ...session.user, id: principal } });
        },
        '/api/v1/orgs/memberships/me': () =>
          json({
            items: [
              membershipFixture(ORG.id, {
                orgName: ORG.name,
                orgSlug: ORG.slug,
                userId: principal,
              }),
            ],
          }),
        [path]: () =>
          principal === 'u1'
            ? json({
                credentialGeneration: 1,
                providers: [instance('google', { lifecycle: 'active' }), instance('samsung')],
              })
            : delayed,
      }),
    });
    expect(await screen.findByText(/Active locally/)).toBeInTheDocument();
    const next = sessionFixture('admin');
    if (!next.authenticated) throw new Error('Expected a signed-in fixture');
    principal = 'u2';
    act(() => {
      const updatedSession: typeof next = { ...next, user: { ...next.user, id: 'u2' } };
      queryClient.setQueryData(sessionQuery.queryKey, updatedSession);
      queryClient.setQueryData(membershipsQuery.queryKey, {
        items: [membershipFixture(ORG.id, { userId: 'u2' })],
      });
    });
    await waitFor(() => expect(screen.queryByText(/Active locally/)).toBeNull());
    await act(async () => {
      finish(
        json({
          credentialGeneration: 2,
          providers: [instance('google', { lifecycle: 'blocked' }), instance('samsung')],
        }),
      );
    });
    expect(await screen.findByText(/Blocked locally/)).toBeInTheDocument();
  });
});
