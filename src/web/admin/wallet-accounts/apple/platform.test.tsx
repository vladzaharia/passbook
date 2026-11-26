import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { json, problem, renderApp } from '@/web/lib/test-utils.tsx';

const DAY = 86_400_000;
const row = (over: Record<string, unknown> = {}) => ({
  id: 'root1',
  orgId: null,
  label: 'Root',
  passTypeIdentifier: 'pass.mobile.passbook',
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
  apnsCheckedAt: Date.now() - 1000,
  apnsReason: null,
  passCount: 0,
  nfcEnabled: false,
  nfcKeys: [],
  isDefault: false,
  createdAt: 1_600_000_000_000,
  kind: 'platform',
  status: 'active',
  rotation: 'auto',
  issuing: true,
  nextRotationAt: Date.now() + 150 * DAY,
  handle: null,
  slot: 'root',
  purpose: 'passes',
  managed: 'connector',
  registrationCount: 3,
  openRunId: null,
  dormant: false,
  ...over,
});
const legacy = row({
  id: 'legacy1',
  slot: null,
  passTypeIdentifier: 'pass.im.plrs.wallet',
  managed: 'deployment',
  isDefault: false,
  passCount: 40,
  registrationCount: 12,
  nextRotationAt: null,
});
const page = (items: unknown[]) => () => json({ items, nextCursor: null });
const PATH = '/admin/platform/wallet-accounts';
const base = {
  '/api/v1/wallet-identities': page([]),
  '/api/v1/orgs': page([]),
};

describe('platform identities', () => {
  it('shows each identity with its state, expiry and counts, accessible', async () => {
    const { container } = await renderApp(PATH, {
      session: 'admin',
      handlers: {
        ...base,
        '/api/v1/platform/apple/identities': () => json({ items: [legacy, row()], openRuns: [] }),
      },
    });
    const cards = await screen.findAllByText(/^(Root|Legacy)$/);
    expect(cards.length).toBeGreaterThanOrEqual(2);
    const legacyCard = document.querySelector('[data-platform-card="legacy"]') as HTMLElement;
    expect(within(legacyCard).getByText('Deployment')).toBeInTheDocument();
    expect(within(legacyCard).getByText('Retires')).toBeInTheDocument();
    expect(within(legacyCard).getByRole('button', { name: 'Move passes' })).toBeInTheDocument();
    expect(within(legacyCard).getByRole('button', { name: 'Make default' })).toBeInTheDocument();
    const rootCard = document.querySelector('[data-platform-card="root"]') as HTMLElement;
    expect(within(rootCard).getByText('Managed')).toBeInTheDocument();
    expect(within(rootCard).getByRole('button', { name: 'Make default' })).toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('hides Set up when both slots exist', async () => {
    await renderApp(PATH, {
      session: 'admin',
      handlers: {
        ...base,
        '/api/v1/platform/apple/identities': () =>
          json({
            items: [row(), row({ id: 'dev1', slot: 'devtest', purpose: 'device_test' })],
            openRuns: [],
          }),
      },
    });
    await screen.findByRole('heading', { name: 'Platform identities' });
    expect(screen.queryByRole('button', { name: 'Set up' })).toBeNull();
  });

  it('sets up a slot with an Idempotency-Key and shows the run', async () => {
    let key: string | null = null;
    let body: unknown;
    await renderApp(PATH, {
      session: 'admin',
      handlers: {
        ...base,
        '/api/v1/platform/apple/identities': (_u, init) => {
          if (init?.method === 'POST') {
            key = new Headers(init.headers).get('idempotency-key');
            body = JSON.parse(String(init.body));
            return json(
              {
                id: 'run1',
                orgId: null,
                kind: 'provision',
                targetType: 'identity',
                targetId: 'x',
                state: 'running',
                step: 'create',
                attempt: 1,
                waitingFor: null,
                errorCode: null,
                createdAt: 1,
                updatedAt: 1,
                finishedAt: null,
              },
              202,
            );
          }
          return json({ items: [legacy], openRuns: [] });
        },
      },
    });
    const ui = userEvent.setup();
    await ui.click(await screen.findByRole('button', { name: 'Set up' }));
    await ui.click(await screen.findByRole('radio', { name: /Root/ }));
    await ui.click(screen.getByRole('button', { name: 'Next' }));
    await ui.click(await screen.findByRole('button', { name: 'Set up' }));
    await waitFor(() => expect(body).toEqual({ slot: 'root' }));
    expect(key).toBeTruthy();
  });

  it('keeps Make default shut until ready, and says what is open', async () => {
    await renderApp(PATH, {
      session: 'admin',
      handlers: {
        ...base,
        '/api/v1/platform/apple/identities': () =>
          json({ items: [legacy, row({ registrationCount: 0 })], openRuns: [] }),
      },
    });
    const ui = userEvent.setup();
    await screen.findByRole('heading', { name: 'Platform identities' });
    await ui.click(
      within(document.querySelector('[data-platform-card="root"]') as HTMLElement).getByRole(
        'button',
        { name: 'Make default' },
      ),
    );
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Device test')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Make default' })).toBeDisabled();
  });

  it('makes the default and shows a refusal', async () => {
    let calls = 0;
    await renderApp(PATH, {
      session: 'admin',
      handlers: {
        ...base,
        '/api/v1/platform/apple/identities': () => json({ items: [legacy, row()], openRuns: [] }),
        '/api/v1/platform/apple/identities/root1/default': () => {
          calls++;
          return problem(409, 'IDENTITY_NOT_READY', 'Push was not checked in the last 24 hours.');
        },
      },
    });
    const ui = userEvent.setup();
    await screen.findByRole('heading', { name: 'Platform identities' });
    await ui.click(
      within(document.querySelector('[data-platform-card="root"]') as HTMLElement).getByRole(
        'button',
        { name: 'Make default' },
      ),
    );
    const dialog = await screen.findByRole('alertdialog');
    await ui.click(within(dialog).getByRole('button', { name: 'Make default' }));
    await waitFor(() => expect(calls).toBe(1));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/24 hours/);
  });

  it('previews a move, starts it, then lists the moves with Arm now', async () => {
    let armed = 0;
    let started: unknown;
    const op = {
      id: 'op1',
      kind: 'identity.move',
      status: 'succeeded',
      title: 'Move passes',
      text: 'Done',
      orgId: 'o1',
      mode: null,
      target: null,
      step: null,
      steps: [],
      attempt: 1,
      cancelable: false,
      cancelRequested: false,
      startedBy: { type: 'user', id: 'u1' },
      createdAt: 1,
      startedAt: 1,
      updatedAt: 2,
      finishedAt: 2,
      error: null,
      result: null,
      revision: 3,
      pollAfterMs: 0,
    };
    await renderApp(PATH, {
      session: 'admin',
      handlers: {
        ...base,
        '/api/v1/orgs': page([
          {
            id: 'o1',
            name: 'Henrys',
            slug: 'henrys',
            status: 'active',
            personal: false,
            createdAt: 1,
            counts: { passes: 30, templates: 1, connections: 0, apiKeys: 0 },
            countsCapped: false,
          },
        ]),
        '/api/v1/platform/apple/identities': () => json({ items: [legacy, row()], openRuns: [] }),
        '/api/v1/platform/apple/identity-moves/preview': () =>
          json({
            toIdentityId: 'root1',
            passes: 30,
            registered: 20,
            holders: 25,
            kept: { connection: 4 },
          }),
        '/api/v1/platform/apple/identity-moves': (_u, init) => {
          if (init?.method === 'POST') {
            started = JSON.parse(String(init.body));
            return json(op, 202);
          }
          return json({
            items: [
              {
                id: 'mv1',
                operationId: 'op1',
                orgId: 'o1',
                fromIdentityId: 'legacy1',
                toIdentityId: 'root1',
                oldPassId: 'old00000001',
                newPassId: 'new00000001',
                state: 'registered',
                reason: 'unarmed',
                conflictCount: 0,
                registeredAt: 1,
                voidAt: null,
                voidedAt: null,
                updatedAt: 1,
              },
            ],
            nextCursor: null,
          });
        },
        '/api/v1/platform/apple/identity-moves/mv1/arm': () => {
          armed++;
          return json({ moveId: 'mv1', armed: true });
        },
      },
    });
    const ui = userEvent.setup();
    await ui.click(await screen.findByRole('button', { name: 'Move passes' }));
    const dialog = await screen.findByRole('dialog');
    within(dialog).getByRole('combobox').focus();
    await ui.keyboard('{Enter}');
    await ui.click(await screen.findByRole('option', { name: 'Henrys' }));
    expect(await within(dialog).findByText('Kept: Connection')).toBeInTheDocument();
    expect(within(dialog).getByText('30')).toBeInTheDocument();
    await ui.click(within(dialog).getByRole('button', { name: 'Move passes' }));
    await waitFor(() => expect(started).toEqual({ orgId: 'o1', fromIdentityId: 'legacy1' }));
    await ui.click(await screen.findByRole('button', { name: 'Done' }));
    const card = await waitFor(() => {
      const el = document.querySelector('[data-platform-moves]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(await within(card).findByText('Unarmed')).toBeInTheDocument();
    await ui.click(within(card).getByRole('button', { name: 'Arm now' }));
    const confirm = await screen.findByRole('alertdialog');
    await ui.click(within(confirm).getByRole('button', { name: 'Arm now' }));
    await waitFor(() => expect(armed).toBe(1));
  });
});
