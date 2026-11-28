import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import type { OrgCapability } from '@/shared/contracts/org-membership.ts';
import { resetModeForTests, setMode } from '@/web/lib/mode.ts';
import { json, membershipFixture, renderApp } from '@/web/lib/test-utils.tsx';
import {
  credential,
  enrolment,
  KEY,
  platformEnrolment,
  renderOrgAccounts,
  walletRelease,
} from './wallet-accounts-test-fixtures.ts';

const READ: OrgCapability[] = ['org:read', 'integrations:read'];
const MANAGE: OrgCapability[] = [...READ, 'integrations:manage'];
const member = (capabilities: OrgCapability[]) =>
  membershipFixture('o1', { orgName: 'North', capabilities });

beforeEach(() => {
  resetModeForTests();
  setMode('test');
});
afterEach(() => resetModeForTests());

function orgHandlers(
  enrolments = [enrolment(), enrolment({ provider: 'samsung' })],
  creds: ReturnType<typeof credential>[] = [],
) {
  return {
    '/api/v1/wallet-identities': () => json({ items: [], nextCursor: null }),
    '/api/v1/orgs/o1/wallet-enrolments': () => json({ items: enrolments, nextCursor: null }),
    '/api/v1/orgs/o1/wallet-credentials': () => json({ items: creds, nextCursor: null }),
  };
}

describe('organization wallet accounts', () => {
  it('shows each wallet with its gates and no axe violations', async () => {
    const { container } = await renderOrgAccounts({
      memberships: [member(MANAGE)],
      handlers: orgHandlers([
        enrolment({
          state: 'off',
          source: 'org',
          prerequisites: { check: true, roundTrip: null },
        }),
        enrolment({ provider: 'samsung' }),
      ]),
    });
    const google = await screen.findByRole('region', { name: 'Google Wallet' });
    expect(within(google).getByText('Enrolment check: Passed')).toBeInTheDocument();
    const samsung = screen.getByRole('region', { name: 'Samsung Wallet' });
    expect(within(samsung).getByText('Pick a source first.')).toBeInTheDocument();
    expect(within(samsung).getByText("Samsung Wallet isn't released yet.")).toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('shows the platform hold and its reason, with no way to release it', async () => {
    await renderOrgAccounts({
      memberships: [member(MANAGE)],
      handlers: orgHandlers([
        enrolment({ state: 'held', source: 'platform', hold: { at: 1, reason: 'abuse report' } }),
        enrolment({ provider: 'samsung' }),
      ]),
    });
    const google = await screen.findByRole('region', { name: 'Google Wallet' });
    expect(within(google).getAllByText('abuse report')).toHaveLength(1);
    expect(within(google).queryByRole('button', { name: /release|hold/i })).toBeNull();
  });

  it('asks for a Test round trip before Live', async () => {
    setMode('live');
    await renderOrgAccounts({
      memberships: [member(MANAGE)],
      handlers: orgHandlers([
        enrolment({
          mode: 'live',
          state: 'off',
          source: 'org',
          prerequisites: { check: true, roundTrip: false },
        }),
        enrolment({ provider: 'samsung', mode: 'live' }),
      ]),
    });
    const google = await screen.findByRole('region', { name: 'Google Wallet' });
    expect(within(google).getByText('Test round trip: Needed')).toBeInTheDocument();
    expect(within(google).getByText('Save a pass from Test mode first.')).toBeInTheDocument();
  });

  it('is read-only without integrations:manage', async () => {
    await renderOrgAccounts({
      memberships: [member(READ)],
      handlers: orgHandlers([
        enrolment({ state: 'off', source: 'org', prerequisites: { check: true, roundTrip: null } }),
        enrolment({ provider: 'samsung' }),
      ]),
    });
    const google = await screen.findByRole('region', { name: 'Google Wallet' });
    expect(
      within(google).queryByRole('button', { name: /add credentials|rotate|revoke/i }),
    ).toBeNull();
    expect(within(google).getAllByText(/Read-only/).length).toBe(1);
  });

  it('makes no wallet request without integrations:read', async () => {
    const { fetchMock } = await renderOrgAccounts({
      memberships: [member(['org:read'])],
      handlers: orgHandlers(),
    });
    await screen.findByRole('button', { name: /^Google Wallet/ });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('wallet-'))).toBe(false);
  });

  it('freezes a revoked enrolment and hides blockers while it is On', async () => {
    await renderOrgAccounts({
      memberships: [member(MANAGE)],
      handlers: orgHandlers(
        [
          enrolment({
            state: 'revoked',
            source: 'org',
            prerequisites: { check: true, roundTrip: null },
          }),
          enrolment({
            provider: 'samsung',
            state: 'on',
            source: 'org',
            prerequisites: { check: false, roundTrip: null },
          }),
        ],
        [credential({ provider: 'google' })],
      ),
    });
    const google = await screen.findByRole('region', { name: 'Google Wallet' });
    for (const radio of within(google).getAllByRole('radio')) expect(radio).toBeDisabled();
    const samsung = screen.getByRole('region', { name: 'Samsung Wallet' });
    expect(within(samsung).queryByText('The account check has not passed.')).toBeNull();
    expect(within(samsung).queryByText('Enrolment check: Needed')).toBeNull();
  });

  it('never shows a green check on a credential whose gate says Needed', async () => {
    await renderOrgAccounts({
      memberships: [member(MANAGE)],
      handlers: orgHandlers(
        [
          enrolment({
            state: 'off',
            source: 'org',
            prerequisites: { check: false, roundTrip: null },
          }),
          enrolment({ provider: 'samsung' }),
        ],
        [credential({ lastCheck: { ok: true, code: null, at: 1_700_000_000_000 } })],
      ),
    });
    const google = await screen.findByRole('region', { name: 'Google Wallet' });
    expect(within(google).getByText(/^Last checked/)).toBeInTheDocument();
    expect(within(google).queryByText(/^Checked /)).toBeNull();
    expect(within(google).getByText('Enrolment check: Needed')).toBeInTheDocument();
  });

  it('shows a green check when the gate passes', async () => {
    await renderOrgAccounts({
      memberships: [member(MANAGE)],
      handlers: orgHandlers(
        [
          enrolment({
            state: 'off',
            source: 'org',
            prerequisites: { check: true, roundTrip: null },
          }),
          enrolment({ provider: 'samsung' }),
        ],
        [credential({ lastCheck: { ok: true, code: null, at: 1_700_000_000_000 } })],
      ),
    });
    const google = await screen.findByRole('region', { name: 'Google Wallet' });
    expect(within(google).getByText(/^Checked /)).toBeInTheDocument();
    expect(within(google).getByText('Enrolment check: Passed')).toBeInTheDocument();
  });

  it('saves credentials, clears the private key and never shows a secret back', async () => {
    const user = userEvent.setup();
    const saved: Record<string, unknown>[] = [];
    await renderOrgAccounts({
      memberships: [member(MANAGE)],
      handlers: {
        ...orgHandlers(),
        '/api/v1/orgs/o1/wallet-credentials': (_u, init) => {
          if (init?.method === 'PUT') {
            saved.push(JSON.parse(String(init.body)));
            return json(credential());
          }
          return json({ items: [], nextCursor: null });
        },
      },
    });
    const google = await screen.findByRole('region', { name: 'Google Wallet' });
    await user.click(within(google).getByRole('button', { name: 'Add credentials' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/Issuer ID/), '3388000000012345');
    await user.type(
      within(dialog).getByLabelText(/Service account email/),
      'wallet@proj.iam.gserviceaccount.com',
    );
    await user.click(within(dialog).getByLabelText(/private key/));
    await user.paste(KEY);
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]).toMatchObject({ provider: 'google', expectedRevision: 0 });
    expect(document.body.textContent).not.toContain('U0VDUkVUX0tFWQ');
  });

  it('refuses a bad credential form with one line and focuses the first field', async () => {
    const user = userEvent.setup();
    await renderOrgAccounts({
      memberships: [member(MANAGE)],
      handlers: orgHandlers(),
    });
    const google = await screen.findByRole('region', { name: 'Google Wallet' });
    await user.click(within(google).getByRole('button', { name: 'Add credentials' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText('Check the highlighted fields.')).toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getByLabelText(/Issuer ID/)).toHaveFocus());
    expect(within(dialog).getAllByText('Required.').length).toBe(3);
  });

  it('sends optional per-type Samsung cards beside the default card', async () => {
    const user = userEvent.setup();
    const saved: Record<string, unknown>[] = [];
    await renderOrgAccounts({
      memberships: [member(MANAGE)],
      handlers: {
        ...orgHandlers(),
        '/api/v1/orgs/o1/wallet-credentials': (_u, init) => {
          if (init?.method === 'PUT') {
            saved.push(JSON.parse(String(init.body)));
            return json(credential({ provider: 'samsung' }));
          }
          return json({ items: [], nextCursor: null });
        },
      },
    });
    const samsung = await screen.findByRole('region', { name: 'Samsung Wallet' });
    await user.click(within(samsung).getByRole('button', { name: 'Add credentials' }));
    const dialog = await screen.findByRole('dialog');
    const cert = '-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----';
    await user.type(within(dialog).getByLabelText(/Partner ID/), 'partner1');
    await user.type(within(dialog).getByLabelText(/Certificate ID/), 'AB12');
    await user.type(within(dialog).getByLabelText(/Default card ID/), 'cardG');
    await user.click(within(dialog).getByLabelText(/Partner private key/));
    await user.paste(KEY);
    await user.click(within(dialog).getByLabelText(/Partner certificate/));
    await user.paste(cert);
    await user.click(within(dialog).getByLabelText(/Samsung certificate/));
    await user.paste(cert);
    await user.type(within(dialog).getByLabelText(/Card for loyalty/), 'bad id');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(saved).toHaveLength(0);
    await user.clear(within(dialog).getByLabelText(/Card for loyalty/));
    await user.type(within(dialog).getByLabelText(/Card for loyalty/), 'cardT');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]).toMatchObject({
      provider: 'samsung',
      credentials: { cardId: 'cardG', cardIds: { loyalty: 'cardT' } },
    });
  });
});

describe('Google account tiles', () => {
  const run = (state: string) => ({
    runId: 'r1',
    state,
    step: null,
    waitingFor: null,
    errorCode: null,
    issuerId: null,
    updatedAt: 1,
  });

  it('starts a managed issuer in Live and shows the run', async () => {
    setMode('live');
    const user = userEvent.setup();
    const posts: unknown[] = [];
    await renderOrgAccounts({
      memberships: [member(MANAGE)],
      handlers: {
        ...orgHandlers([
          enrolment({ mode: 'live' }),
          enrolment({ provider: 'samsung', mode: 'live' }),
        ]),
        '/api/v1/orgs/o1/wallet-accounts/google/managed': (_u, init) => {
          if (init?.method === 'POST') {
            posts.push(JSON.parse(String(init.body)));
            return json(run('running'), 202);
          }
          return json({ run: posts.length ? run('running') : null });
        },
      },
    });
    const google = await screen.findByRole('region', { name: 'Google Wallet' });
    expect(screen.getByRole('radio', { name: /Managed by PassBook/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /Share your issuer/ })).toBeInTheDocument();
    expect(within(google).getByText('Own credentials')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Create the issuer' }));
    await waitFor(() => expect(posts).toEqual([{ mode: 'live' }]));
    expect(await screen.findByRole('list', { name: 'Setup steps' })).toBeInTheDocument();
  });

  it('shares an own issuer with the service account address', async () => {
    setMode('live');
    const user = userEvent.setup();
    const posts: unknown[] = [];
    await renderOrgAccounts({
      memberships: [member(MANAGE)],
      handlers: {
        ...orgHandlers([
          enrolment({ mode: 'live' }),
          enrolment({ provider: 'samsung', mode: 'live' }),
        ]),
        '/api/v1/orgs/o1/wallet-accounts/google/managed': () => json({ run: null }),
        '/api/v1/orgs/o1/wallet-accounts/google/shared': (_u, init) => {
          if (init?.method === 'POST') {
            posts.push(JSON.parse(String(init.body)));
            return json({ credential: credential(), serviceAccountEmail: 'sa@passbook.iam' });
          }
          return json({ serviceAccountEmail: 'sa@passbook.iam' });
        },
      },
    });
    await user.click(await screen.findByRole('radio', { name: /Share your issuer/ }));
    expect(await screen.findByText('sa@passbook.iam')).toBeInTheDocument();
    const connect = screen.getByRole('button', { name: 'Connect' });
    expect(connect).toBeDisabled();
    await user.type(screen.getByLabelText('Issuer ID'), '3388000000012345');
    await user.click(connect);
    await waitFor(() => expect(posts).toEqual([{ issuerId: '3388000000012345' }]));
  });

  it('leaves the choice to those who can manage accounts', async () => {
    await renderOrgAccounts({
      memberships: [member(READ)],
      handlers: orgHandlers([enrolment(), enrolment({ provider: 'samsung' })]),
    });
    expect(await screen.findByRole('radio', { name: /Managed by PassBook/ })).toBeDisabled();
  });
});

describe('platform wallet accounts', () => {
  const handlers = (
    items = [
      platformEnrolment(),
      platformEnrolment({
        orgId: 'o2',
        orgName: 'Acme',
        state: 'held',
        hold: { at: 1, reason: 'abuse' },
        mode: 'test',
      }),
    ],
  ) => ({
    '/api/v1/wallet-identities': () => json({ items: [], nextCursor: null }),
    '/api/v1/platform/wallet-credentials': () =>
      json({
        items: [credential({ scope: 'platform', orgId: null, mode: 'live' })],
        nextCursor: null,
        release: walletRelease(true),
      }),
    '/api/v1/platform/wallet-enrolments': () => json({ items, nextCursor: null }),
  });

  it('lists credentials per mode and every organization, with hold and release', async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    const { container } = await renderApp('/admin/platform/wallet-accounts', {
      session: 'admin',
      handlers: {
        ...handlers(),
        '/api/v1/platform/orgs/o1/wallet-enrolments/live/google/hold': (_u, init) => {
          calls.push(`hold ${init?.body}`);
          return json({ status: 'held' });
        },
        '/api/v1/platform/orgs/o2/wallet-enrolments/test/google/release': () => {
          calls.push('release');
          return json({ status: 'released' });
        },
      },
    });
    await user.click(await screen.findByRole('tab', { name: 'Google' }));
    expect(await screen.findByText('…4321')).toBeInTheDocument();
    expect(screen.getByText('No credentials')).toBeInTheDocument();
    expect(screen.getByText('abuse')).toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Release Acme, Test' }));
    await waitFor(() => expect(calls).toContain('release'));
    await user.click(screen.getByRole('button', { name: 'Hold North, Live' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Hold' }));
    expect(await within(dialog).findByText('Required.')).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/Reason/), 'abuse');
    await user.click(within(dialog).getByRole('button', { name: 'Hold' }));
    await waitFor(() => expect(calls).toContain('hold {"reason":"abuse"}'));
  });

  it('clears the hold reason when the dialog is cancelled', async () => {
    const user = userEvent.setup();
    await renderApp('/admin/platform/wallet-accounts', {
      session: 'admin',
      handlers: handlers(),
    });
    await user.click(await screen.findByRole('tab', { name: 'Google' }));
    await user.click(await screen.findByRole('button', { name: 'Hold North, Live' }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(within(dialog).getByLabelText(/Reason/)).toHaveFocus());
    await user.type(within(dialog).getByLabelText(/Reason/), 'abuse');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await user.click(screen.getByRole('button', { name: 'Hold North, Live' }));
    expect(await within(await screen.findByRole('dialog')).findByLabelText(/Reason/)).toHaveValue(
      '',
    );
  });

  it('loads more enrolments with the cursor', async () => {
    const user = userEvent.setup();
    const cursors: (string | null)[] = [];
    await renderApp('/admin/platform/wallet-accounts', {
      session: 'admin',
      handlers: {
        ...handlers(),
        '/api/v1/platform/wallet-enrolments': (url) => {
          const cursor = url.searchParams.get('cursor');
          cursors.push(cursor);
          return json(
            cursor
              ? { items: [platformEnrolment({ orgId: 'o9', orgName: 'Zeta' })], nextCursor: null }
              : { items: [platformEnrolment()], nextCursor: 'c1' },
          );
        },
      },
    });
    await user.click(await screen.findByRole('tab', { name: 'Google' }));
    await user.click(await screen.findByRole('button', { name: /load more/i }));
    expect(await screen.findByText('Zeta')).toBeInTheDocument();
    expect(cursors).toEqual([null, 'c1']);
    expect(screen.getByText('North')).toBeInTheDocument();
  });

  it('keeps the Apple identities on the first tab', async () => {
    await renderApp('/admin/platform/wallet-accounts', { session: 'admin', handlers: handlers() });
    expect(await screen.findByRole('heading', { name: 'Apple identities' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Apple', selected: true })).toBeInTheDocument();
  });

  it('redirects the old identities route', async () => {
    const { router } = await renderApp('/admin/identities', {
      session: 'admin',
      handlers: handlers(),
    });
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/admin/platform/wallet-accounts'),
    );
  });
});
