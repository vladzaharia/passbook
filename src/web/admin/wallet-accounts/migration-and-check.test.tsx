import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import type { OrgCapability } from '@/shared/contracts/org-membership.ts';
import { resetModeForTests, setMode } from '@/web/lib/mode.ts';
import { json, membershipFixture, problem, renderApp } from '@/web/lib/test-utils.tsx';
import { credential, enrolment } from './wallet-accounts-test-fixtures.ts';

const MANAGE: OrgCapability[] = ['org:read', 'integrations:read', 'integrations:manage'];
beforeEach(() => {
  resetModeForTests();
  setMode('test');
});
afterEach(() => resetModeForTests());

const orgHandlers = (check: (init: RequestInit | undefined) => Response) => ({
  '/api/v1/identities': () => json({ items: [], nextCursor: null }),
  '/api/v1/orgs/o1/wallet-enrolments': () =>
    json({
      items: [
        enrolment({
          state: 'off',
          source: 'org',
          prerequisites: { check: false, roundTrip: null },
        }),
        enrolment({ provider: 'samsung' }),
      ],
    }),
  '/api/v1/orgs/o1/wallet-credentials': () => json({ items: [credential()] }),
  '/api/v1/orgs/o1/wallet-credentials/c1/check': (_u: URL, init: RequestInit | undefined) =>
    check(init),
  '/api/v1/orgs/o1/wallet-credentials/c1/checks/k1': () =>
    json({ checkId: 'k1', status: 'failed', code: 'auth_failed', checkedAt: 1 }),
});
const north = membershipFixture('o1', { orgName: 'North', capabilities: MANAGE });

describe('credential check', () => {
  it('queues, polls and says why a check failed', async () => {
    const user = userEvent.setup();
    await renderApp('/admin/o/o1/wallet-accounts', {
      memberships: [north],
      handlers: orgHandlers(() => json({ checkId: 'k1', status: 'queued' })),
    });
    const google = await screen.findByRole('region', { name: 'Google Wallet' });
    await user.click(within(google).getByRole('button', { name: 'Check' }));
    expect(
      await within(google).findByText(
        /The provider refused the credentials/,
        {},
        { timeout: 6000 },
      ),
    ).toBeInTheDocument();
  });

  it('shows the wait when checks are rate limited', async () => {
    const user = userEvent.setup();
    await renderApp('/admin/o/o1/wallet-accounts', {
      memberships: [north],
      handlers: orgHandlers(() => problem(429, 'RATE_LIMITED', 'Slow down.')),
    });
    const google = await screen.findByRole('region', { name: 'Google Wallet' });
    await user.click(within(google).getByRole('button', { name: 'Check' }));
    expect(await screen.findByText('Wait a minute before checking again.')).toBeInTheDocument();
  });
});

describe('check abort', () => {
  it('aborts the poll when the page unmounts', async () => {
    const user = userEvent.setup();
    const signals: AbortSignal[] = [];
    const base = orgHandlers(() => json({ checkId: 'k1', status: 'queued' }));
    const { unmount } = await renderApp('/admin/o/o1/wallet-accounts', {
      memberships: [north],
      handlers: {
        ...base,
        '/api/v1/orgs/o1/wallet-credentials/c1/check': (_u, init) => {
          if (init?.signal) signals.push(init.signal);
          return json({ checkId: 'k1', status: 'queued' });
        },
      },
    });
    const google = await screen.findByRole('region', { name: 'Google Wallet' });
    await user.click(within(google).getByRole('button', { name: 'Check' }));
    await waitFor(() => expect(signals).toHaveLength(1));
    expect(signals[0]?.aborted).toBe(false);
    unmount();
    expect(signals[0]?.aborted).toBe(true);
  });
});

describe('migration', () => {
  const item = (over: Record<string, unknown>) => ({
    accountId: 'a1',
    orgId: 'o1',
    mode: 'live',
    provider: 'google',
    state: 'refused',
    reason: 'identity_shared',
    identityShared: [{ orgId: 'o2', mode: 'live', provider: 'google' }],
    ...over,
  });
  const handlers = (resolve: (body: unknown) => Response) => ({
    '/api/v1/identities': () => json({ items: [], nextCursor: null }),
    '/api/v1/platform/wallet-credentials': () => json({ items: [] }),
    '/api/v1/platform/wallet-enrolments': () => json({ items: [], nextCursor: null }),
    '/api/v1/platform/wallet-credentials/migrate': (_u: URL, init: RequestInit | undefined) =>
      init?.method === 'POST'
        ? json({ queued: 2 })
        : json({
            pending: 2,
            migrated: 5,
            next: null,
            items: [
              item({}),
              item({
                accountId: 'a2',
                orgId: 'o2',
                reason: 'unproven_claim',
                identityShared: [{ orgId: 'o1', mode: 'live', provider: 'google' }],
              }),
            ],
          }),
    '/api/v1/platform/wallet-credentials/migrate/resolve': (
      _u: URL,
      init: RequestInit | undefined,
    ) => resolve(JSON.parse(String(init?.body))),
  });

  it('lists refused accounts naming the others, and resolves behind a confirm', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    const { container } = await renderApp('/admin/platform/wallet-accounts', {
      session: 'admin',
      handlers: handlers((b) => {
        bodies.push(b);
        return json({ accounts: 1 });
      }),
    });
    await user.click(await screen.findByRole('tab', { name: 'Migration' }));
    expect(await screen.findByText('2 pending, 5 migrated')).toBeInTheDocument();
    expect(
      screen.getByText(/Claims an identity PassBook cannot prove\. Also claimed by o1/),
    ).toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);
    await user.click(screen.getByRole('button', { name: /^Use PassBook o1/ }));
    const dialog = await screen.findByRole('alertdialog');
    expect(bodies).toEqual([]);
    await user.click(within(dialog).getByRole('button', { name: 'Assign' }));
    await waitFor(() =>
      expect(bodies).toEqual([
        { orgId: 'o1', mode: 'live', provider: 'google', action: 'assign_platform' },
      ]),
    );
  });

  it('says plainly when retire is refused for live passes', async () => {
    const user = userEvent.setup();
    await renderApp('/admin/platform/wallet-accounts', {
      session: 'admin',
      handlers: handlers(() => problem(409, 'WALLET_ACCOUNT_INSTANCES_ACTIVE', 'secret detail')),
    });
    await user.click(await screen.findByRole('tab', { name: 'Migration' }));
    await user.click(await screen.findByRole('button', { name: /^Retire o1/ }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Retire' }));
    expect(
      await within(dialog).findByText('It still has live wallet passes. Retire them first.'),
    ).toBeInTheDocument();
  });

  it('offers only the actions the API accepts for each reason', async () => {
    const user = userEvent.setup();
    const base = handlers(() => json({ accounts: 1 }));
    await renderApp('/admin/platform/wallet-accounts', {
      session: 'admin',
      handlers: {
        ...base,
        '/api/v1/platform/wallet-credentials/migrate': () =>
          json({
            pending: 4,
            migrated: 0,
            next: null,
            items: [
              item({ accountId: 'a1', orgId: 'o1', reason: 'identity_shared' }),
              item({ accountId: 'a2', orgId: 'o2', reason: 'unproven_claim' }),
              item({
                accountId: 'a3',
                orgId: 'o3',
                reason: 'org_credential_exists',
                identityShared: [],
              }),
              item({ accountId: 'a4', orgId: 'o4', reason: 'unreadable', identityShared: [] }),
            ],
          }),
      },
    });
    await user.click(await screen.findByRole('tab', { name: 'Migration' }));
    await screen.findByText(/Shares its provider identity/);
    const has = (verb: string, org: string) =>
      screen.queryByRole('button', { name: new RegExp(`^${verb} ${org}`) }) !== null;
    expect(
      ['o1', 'o2'].map((o) => [has('Use PassBook', o), has('Merge', o), has('Retire', o)]),
    ).toEqual([
      [true, true, true],
      [true, true, true],
    ]);
    expect([has('Use PassBook', 'o3'), has('Merge', 'o3'), has('Retire', 'o3')]).toEqual([
      true,
      false,
      true,
    ]);
    expect([has('Use PassBook', 'o4'), has('Merge', 'o4'), has('Retire', 'o4')]).toEqual([
      false,
      false,
      true,
    ]);
  });

  it('names the claimants in the merge confirm', async () => {
    const user = userEvent.setup();
    await renderApp('/admin/platform/wallet-accounts', {
      session: 'admin',
      handlers: handlers(() => json({ accounts: 2 })),
    });
    await user.click(await screen.findByRole('tab', { name: 'Migration' }));
    await user.click(await screen.findByRole('button', { name: /^Merge o1/ }));
    expect(
      await screen.findByText(
        "This identity becomes PassBook's credential. o1, o2 and any other organization that claims it will sign with it.",
      ),
    ).toBeInTheDocument();
  });

  it('runs the migration after a confirm', async () => {
    const user = userEvent.setup();
    await renderApp('/admin/platform/wallet-accounts', {
      session: 'admin',
      handlers: handlers(() => json({ accounts: 1 })),
    });
    await user.click(await screen.findByRole('tab', { name: 'Migration' }));
    await user.click(await screen.findByRole('button', { name: 'Run migration' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Run' }),
    );
    expect(await screen.findByText('2 accounts queued')).toBeInTheDocument();
  });
});
