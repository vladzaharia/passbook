import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { newOrgFacts, readyFacts, viewOf } from '@/shared/pass-setup-test-fixtures.ts';
import { json, membershipFixture, problem, renderApp } from '@/web/lib/test-utils.tsx';

const DAY = 86_400_000;
const managed = (over: Record<string, unknown> = {}) => ({
  id: 'm1',
  orgId: 'o1',
  label: 'North (PassBook)',
  passTypeIdentifier: 'pass.mobile.passbook.north',
  teamIdentifier: 'TEAM123',
  source: 'db',
  certSha256: 'ab12',
  certSubject: null,
  certSerial: null,
  notBefore: 1_600_000_000_000,
  notAfter: Date.now() + 200 * DAY,
  daysRemaining: 200,
  apnsBinding: null,
  apnsAvailable: true,
  pushMethod: 'key',
  pushKey: null,
  apnsHealth: 'healthy',
  nfcEnabled: false,
  isDefault: false,
  createdAt: 1_600_000_000_000,
  kind: 'managed',
  status: 'active',
  rotation: 'auto',
  issuing: true,
  nextRotationAt: Date.UTC(2027, 9, 1, 12),
  handle: 'north',
  ...over,
});
const cert = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  state: 'active',
  origin: 'asc',
  certSha256: 'ab12',
  notBefore: Date.UTC(2026, 9, 1),
  notAfter: Date.UTC(2027, 9, 1, 12),
  createdAt: Date.UTC(2026, 9, 1),
  activatedAt: Date.UTC(2026, 9, 1),
  endedAt: null,
  ...over,
});
const run = (over: Record<string, unknown> = {}) => ({
  id: 'r1',
  orgId: 'o1',
  kind: 'rotate',
  targetType: 'identity',
  targetId: 'm1',
  state: 'failed',
  step: 'issue',
  attempt: 2,
  waitingFor: null,
  errorCode: 'ASC_UPSTREAM',
  createdAt: Date.now() - DAY,
  updatedAt: Date.now() - DAY,
  finishedAt: Date.now() - DAY,
  ...over,
});
const page = (items: unknown[]) => () => json({ items, nextCursor: null });
const PATH = '/admin/platform/wallet-accounts/m1';

function detailHandlers(
  extra: Record<string, never | ((url: URL, init?: RequestInit) => Response)> = {},
) {
  return {
    '/api/v1/identities/m1': () => json(managed()),
    '/api/v1/identities/m1/certificates': page([
      cert({ id: 'c2', state: 'superseded', notAfter: Date.UTC(2026, 11, 1) }),
      cert(),
    ]),
    '/api/v1/identity-runs': page([run()]),
    '/api/v1/orgs': page([]),
    ...extra,
  };
}

describe('managed identity detail', () => {
  it('shows certificates, runs and the managed actions, accessible', async () => {
    const { container } = await renderApp(PATH, { session: 'admin', handlers: detailHandlers() });
    expect(await screen.findByRole('heading', { name: 'North (PassBook)' })).toBeInTheDocument();
    expect(await screen.findByText('Replaced')).toBeInTheDocument();
    expect(screen.getByText('ASC_UPSTREAM')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Renew now' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('starts a renewal', async () => {
    let renewed = 0;
    await renderApp(PATH, {
      session: 'admin',
      handlers: detailHandlers({
        '/api/v1/identities/m1/renew': () => {
          renewed++;
          return json(run({ state: 'queued', errorCode: null }), 202);
        },
      }),
    });
    const ui = userEvent.setup();
    await ui.click(await screen.findByRole('button', { name: 'Renew now' }));
    await waitFor(() => expect(renewed).toBe(1));
  });

  it('disables Renew now while auto-renew is paused', async () => {
    await renderApp(PATH, {
      session: 'admin',
      handlers: detailHandlers({
        '/api/v1/identities/m1': () => json(managed({ rotation: 'manual' })),
      }),
    });
    expect(await screen.findByRole('button', { name: 'Renew now' })).toBeDisabled();
  });

  it('pauses auto-renew from the menu', async () => {
    let body: unknown;
    await renderApp(PATH, {
      session: 'admin',
      handlers: detailHandlers({
        '/api/v1/identities/m1': (_u, init) => {
          if (init?.method === 'PATCH') {
            body = JSON.parse(String(init.body));
            return json(managed({ rotation: 'manual' }));
          }
          return json(managed());
        },
      }),
    });
    const ui = userEvent.setup();
    await ui.click(await screen.findByRole('button', { name: 'More' }));
    await ui.click(await screen.findByRole('menuitem', { name: 'Pause auto-renew' }));
    await waitFor(() => expect(body).toEqual({ rotation: 'manual' }));
  });

  it('stops new passes only after confirmation', async () => {
    const bodies: unknown[] = [];
    await renderApp(PATH, {
      session: 'admin',
      handlers: detailHandlers({
        '/api/v1/identities/m1': (_u, init) => {
          if (init?.method === 'PATCH') {
            bodies.push(JSON.parse(String(init.body)));
            return json(managed({ issuing: false, status: 'retired' }));
          }
          return json(managed());
        },
      }),
    });
    const ui = userEvent.setup();
    await ui.click(await screen.findByRole('button', { name: 'More' }));
    await ui.click(await screen.findByRole('menuitem', { name: 'Stop new passes' }));
    expect(bodies).toEqual([]);
    await ui.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Stop new passes',
      }),
    );
    await waitFor(() => expect(bodies).toEqual([{ issuing: false }]));
  });

  it('revokes a replaced certificate only after the pass type ID is typed', async () => {
    let body: unknown;
    await renderApp(PATH, {
      session: 'admin',
      handlers: detailHandlers({
        '/api/v1/identities/m1/revoke-certificate': (_u, init) => {
          body = JSON.parse(String(init?.body));
          return json(cert({ id: 'c2', state: 'revoked' }));
        },
      }),
    });
    const ui = userEvent.setup();
    // Only the replaced certificate offers it.
    const revoke = await screen.findByRole('button', { name: 'Revoke certificate' });
    expect(screen.getAllByRole('button', { name: 'Revoke certificate' })).toHaveLength(1);
    await ui.click(revoke);
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getAllByRole('button', { name: 'Revoke certificate' }).at(-1)!;
    expect(confirm).toBeDisabled();
    await ui.type(within(dialog).getByRole('textbox'), 'pass.mobile.passbook.north');
    await ui.click(confirm);
    await waitFor(() =>
      expect(body).toEqual({
        certificateId: 'c2',
        reason: 'compromised',
        confirm: 'pass.mobile.passbook.north',
      }),
    );
  });

  it('offers none of it for an uploaded identity', async () => {
    await renderApp(PATH, {
      session: 'admin',
      handlers: detailHandlers({
        '/api/v1/identities/m1': () => json(managed({ kind: 'own', rotation: 'manual' })),
      }),
    });
    expect(await screen.findByRole('heading', { name: 'North (PassBook)' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Renew now' })).toBeNull();
    expect(screen.queryByText('Runs')).toBeNull();
  });
});

describe('run actions', () => {
  it('retries a failed run and cancels an open one', async () => {
    const calls: string[] = [];
    await renderApp(PATH, {
      session: 'admin',
      handlers: detailHandlers({
        '/api/v1/identity-runs': page([
          run(),
          run({ id: 'r2', state: 'running', errorCode: null, finishedAt: null }),
        ]),
        '/api/v1/identity-runs/r1/retry': () => {
          calls.push('retry');
          return json(run({ id: 'r3', state: 'queued' }), 202);
        },
        '/api/v1/identity-runs/r2/cancel': () => {
          calls.push('cancel');
          return json(run({ id: 'r2', state: 'cancelled' }));
        },
      }),
    });
    const ui = userEvent.setup();
    await ui.click(await screen.findByRole('button', { name: 'Retry' }));
    await ui.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(calls).toEqual(['retry', 'cancel']));
  });
});

describe('New managed ID', () => {
  const orgs = page([
    {
      id: 'o1',
      name: 'North',
      slug: 'north-gym',
      status: 'active',
      defaultIdentityId: null,
      branding: {},
      createdAt: 1,
      updatedAt: 1,
      counts: { passes: 0, templates: 0, connections: 0, apiKeys: 0 },
      countsCapped: false,
    },
  ]);
  const open = async (handlers: Record<string, (url: URL, init?: RequestInit) => Response>) => {
    await renderApp('/admin/platform/wallet-accounts', {
      session: 'admin',
      handlers: { '/api/v1/wallet-identities': page([]), '/api/v1/orgs': orgs, ...handlers },
    });
    const ui = userEvent.setup();
    await ui.click((await screen.findAllByRole('button', { name: 'New managed ID' }))[0]!);
    return { ui, dialog: await screen.findByRole('dialog') };
  };

  it('previews the handle and starts the run with an Idempotency-Key', async () => {
    let seen: { body: unknown; key: string | null } | undefined;
    const { ui, dialog } = await open({
      '/api/v1/orgs/o1/identities/apple': (_u, init) => {
        seen = {
          body: JSON.parse(String(init?.body)),
          key: new Headers(init?.headers).get('idempotency-key'),
        };
        return json(
          run({ kind: 'provision', targetType: 'org', targetId: 'o1', state: 'queued' }),
          202,
        );
      },
    });
    expect(within(dialog).getByText('pass.mobile.passbook.<handle>')).toBeInTheDocument();
    await ui.click(within(dialog).getByRole('combobox', { name: /Organization/ }));
    await ui.click(await screen.findByRole('option', { name: 'North' }));
    expect(within(dialog).getByText('pass.mobile.passbook.northgym')).toBeInTheDocument();
    await ui.type(within(dialog).getByLabelText('Handle'), 'north');
    expect(within(dialog).getByText('pass.mobile.passbook.north')).toBeInTheDocument();
    await ui.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(seen?.body).toEqual({ handle: 'north' }));
    expect(seen?.key).toBeTruthy();
  });

  it('asks for an organization and a valid handle', async () => {
    const { ui, dialog } = await open({});
    await ui.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(await within(dialog).findByText('Choose an organization.')).toBeInTheDocument();
  });

  it('shows the server refusal in the dialog', async () => {
    const { ui, dialog } = await open({
      '/api/v1/orgs/o1/identities/apple': () =>
        problem(
          403,
          'FEATURE_NOT_INCLUDED',
          "Managed Pass Type ID isn't included for this organization.",
        ),
    });
    await ui.click(within(dialog).getByRole('combobox', { name: /Organization/ }));
    await ui.click(await screen.findByRole('option', { name: 'North' }));
    await ui.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(await within(dialog).findByRole('alert')).toBeInTheDocument();
  });
});

describe('Apple API tab', () => {
  it('lists the provisioner calls, and says when it is not connected', async () => {
    await renderApp('/admin/platform/wallet-accounts', {
      session: 'admin',
      handlers: {
        '/api/v1/wallet-identities': page([]),
        '/api/v1/platform/apple-calls': () =>
          json({
            available: true,
            items: [
              {
                id: 1,
                callId: 'c1',
                phase: 'end',
                method: 'createPassType',
                target: 'north',
                caller: null,
                status: 'ok',
                durationMs: 120,
                at: Date.now() - 60_000,
              },
            ],
          }),
      },
    });
    const ui = userEvent.setup();
    await ui.click(await screen.findByRole('tab', { name: 'Apple API' }));
    expect(await screen.findByText('createPassType')).toBeInTheDocument();
  });

  it('shows the error state with Retry when the call fails', async () => {
    await renderApp('/admin/platform/wallet-accounts', {
      session: 'admin',
      handlers: {
        '/api/v1/wallet-identities': page([]),
        '/api/v1/platform/apple-calls': () =>
          problem(503, 'APPLE_PROVISIONER_UNAVAILABLE', 'The Apple provisioner is not reachable.'),
      },
    });
    const ui = userEvent.setup();
    await ui.click(await screen.findByRole('tab', { name: 'Apple API' }));
    expect(await screen.findByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('reads as not connected without the binding', async () => {
    await renderApp('/admin/platform/wallet-accounts', {
      session: 'admin',
      handlers: {
        '/api/v1/wallet-identities': page([]),
        '/api/v1/platform/apple-calls': () => json({ available: false, items: [] }),
      },
    });
    const ui = userEvent.setup();
    await ui.click(await screen.findByRole('tab', { name: 'Apple API' }));
    expect(await screen.findByText('Provisioner not connected')).toBeInTheDocument();
  });
});

describe('organization Apple row', () => {
  const north = membershipFixture('o1', { orgName: 'North' });
  const base = (view: unknown) => ({
    '/api/v1/orgs/o1/pass-setup': () => json(view),
    '/api/v1/wallet-identities': page([]),
    '/api/v1/identity-runs': page([run({ state: 'succeeded', errorCode: null })]),
    '/api/v1/identities/idn_1/certificates': page([cert()]),
  });

  it('shows the managed ID on one line and opens the history', async () => {
    await renderApp('/admin/o/o1/brand', {
      session: 'user',
      memberships: [north],
      handlers: base(viewOf(readyFacts())),
    });
    const ui = userEvent.setup();
    await ui.click(await screen.findByRole('button', { name: /^Apple Wallet/ }));
    expect(await screen.findByText('pass.mobile.passbook.acmefitness')).toBeInTheDocument();
    await ui.click(screen.getByRole('button', { name: 'History' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Renewal')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Revoke certificate' })).toBeNull();
  });

  it('offers an own ID to an owner on the shared identity, not to a reader', async () => {
    const view = viewOf(newOrgFacts());
    const ui = userEvent.setup();
    const { unmount } = await renderApp('/admin/o/o1/brand', {
      session: 'user',
      memberships: [north],
      handlers: base(view),
    });
    await ui.click(await screen.findByRole('button', { name: /^Apple Wallet/ }));
    const channels = await screen.findByRole('region', { name: 'Channels' });
    expect(within(channels).getByRole('button', { name: 'Get your own ID' })).toBeInTheDocument();
    unmount();
    await renderApp('/admin/o/o1/brand', {
      session: 'user',
      memberships: [membershipFixture('o1', { capabilities: ['org:read'] })],
      handlers: base(view),
    });
    await ui.click(await screen.findByRole('button', { name: /^Apple Wallet/ }));
    const readOnly = await screen.findByRole('region', { name: 'Channels' });
    expect(within(readOnly).queryByRole('button', { name: 'Get your own ID' })).toBeNull();
  });
});
