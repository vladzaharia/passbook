import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { json, renderApp } from '@/web/lib/test-utils.tsx';
import { fixtureOperation } from '@/web/ui/operation/fixtures.test-support.ts';

const NOW = Date.now();
const status = (over: Record<string, unknown> = {}) => ({
  connected: true,
  mode: 'dry_run',
  frozen: false,
  keyExpiresAt: NOW + 60 * 86_400_000,
  problems: [],
  budget: { snapshot: { day: 28, limit: 30 }, health: { day: 4, limit: 300 } },
  lastScimAt: NOW - 3 * 60_000,
  drift: {},
  breakerOpen: false,
  ...over,
});
const settings = {
  items: [],
  oidc: {
    issuer: 'https://id.plrs.im',
    platformAdminGroup: [],
    platformAdminPinned: 0,
    adminGroup: [],
    developerGroup: [],
    userGroup: [],
    consoleGroupRequired: false,
  },
  released: { google: false, samsung: false },
};
const checkOp = (st: 'running' | 'succeeded') =>
  fixtureOperation(
    {
      kind: 'idp.check',
      title: 'Check Polaris ID',
      doneTitle: 'Polaris ID checked',
      failTitle: 'Could not check Polaris ID',
      steps: [
        { key: 'connect', label: 'Check Polaris ID', active: 'Checking that Polaris ID is ready' },
        { key: 'compare', label: 'Compare groups', active: 'Comparing groups' },
      ],
    },
    { status: st, at: 'connect', id: 'op-check' },
  );

const handlers = (over: Record<string, (u: URL, i?: RequestInit) => Response> = {}) => ({
  '/api/v1/settings': () => json(settings),
  '/api/v1/platform/idp': () => json(status()),
  '/api/v1/platform/idp/drift': () => json({ items: [], nextCursor: null }),
  '/api/v1/platform/idp/setup': () => json({ mode: 'dry_run', items: [] }),
  ...over,
});

describe('Polaris ID on Settings', () => {
  it('shows nothing while the binding is absent', async () => {
    await renderApp('/admin/settings', {
      session: 'admin',
      handlers: handlers({ '/api/v1/platform/idp': () => json(status({ connected: false })) }),
    });
    await screen.findByRole('heading', { name: 'Platform settings' });
    await waitFor(() => expect(screen.queryByText('Polaris ID access')).toBeNull());
    expect(screen.queryByRole('button', { name: 'Check now' })).toBeNull();
  });

  it('shows mode, the snapshot budget left and the empty differences', async () => {
    const { container } = await renderApp('/admin/settings', {
      session: 'admin',
      handlers: handlers(),
    });
    expect(await screen.findByRole('heading', { name: 'Polaris ID access' })).toBeInTheDocument();
    expect(screen.getByText('Dry run')).toBeInTheDocument();
    expect(screen.getByText('2 of 30 group reads left today.')).toBeInTheDocument();
    expect(await screen.findByText('No differences')).toBeInTheDocument();
    // In dry run Check now already records only: the separate dry run is for a live binding.
    expect(screen.queryByRole('button', { name: 'Dry run' })).toBeNull();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('starts Check now after a confirm and follows the operation inline', async () => {
    const bodies: unknown[] = [];
    await renderApp('/admin/settings', {
      session: 'admin',
      handlers: handlers({
        '/api/v1/platform/idp/reconcile': (_u, init) => {
          bodies.push(JSON.parse(String(init?.body)));
          return json({ operation: checkOp('running') }, 202);
        },
        '/api/v1/operations/op-check': () => json(checkOp('running')),
      }),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Check now' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(within(confirm).getByText(/2 group reads left today/)).toBeInTheDocument();
    await user.click(within(confirm).getByRole('button', { name: 'Check now' }));
    await waitFor(() => expect(bodies).toEqual([{ dryRun: false }]));
    expect(
      (await screen.findAllByText(/Checking that Polaris ID is ready/)).length,
    ).toBeGreaterThan(0);
    // One operation at a time: the controls wait for it.
    expect(screen.getByRole('button', { name: 'Check now' })).toBeDisabled();
  });

  it('offers a dry run while live, and disables checks when no group reads are left', async () => {
    await renderApp('/admin/settings', {
      session: 'admin',
      handlers: handlers({
        '/api/v1/platform/idp': () =>
          json(status({ mode: 'live', budget: { snapshot: { day: 30, limit: 30 } } })),
      }),
    });
    expect(await screen.findByRole('button', { name: 'Dry run' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Check now' })).toBeDisabled();
    expect(screen.getByText(/waits until tomorrow/)).toBeInTheDocument();
  });

  it('clears a tripped SCIM breaker through its operation', async () => {
    let cleared = 0;
    await renderApp('/admin/settings', {
      session: 'admin',
      handlers: handlers({
        '/api/v1/platform/idp': () => json(status({ breakerOpen: true })),
        '/api/v1/platform/idp/scim-breaker/clear': () => {
          cleared += 1;
          return json({ operation: checkOp('running') }, 202);
        },
        '/api/v1/operations/op-check': () => json(checkOp('running')),
      }),
    });
    const user = userEvent.setup();
    expect(await screen.findByText('SCIM breaker tripped')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear breaker' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Clear' }),
    );
    await waitFor(() => expect(cleared).toBe(1));
  });

  it('pauses changes with a reason and lists differences', async () => {
    const bodies: unknown[] = [];
    await renderApp('/admin/settings', {
      session: 'admin',
      handlers: handlers({
        '/api/v1/platform/idp/drift': () =>
          json({
            items: [
              { id: 'd1', userId: 'u1', target: 'console', kind: 'missing', foundAt: NOW - 60_000 },
              {
                id: 'd2',
                userId: null,
                target: 'g:partners',
                kind: 'unknown_member',
                foundAt: NOW,
              },
            ],
            nextCursor: null,
          }),
        '/api/v1/platform/idp/freeze': (_u, init) => {
          bodies.push(JSON.parse(String(init?.body)));
          return json({ result: 'frozen' });
        },
      }),
    });
    const user = userEvent.setup();
    expect(await screen.findByText('Missing')).toBeInTheDocument();
    expect(screen.getByText('Unknown member')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Pause changes' }));
    const dialog = await screen.findByRole('dialog', { name: 'Pause Polaris ID changes?' });
    await user.click(within(dialog).getByRole('button', { name: 'Pause changes' }));
    expect(await within(dialog).findByText('Say why, in a few words.')).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/Reason/), 'Drift storm');
    await user.click(within(dialog).getByRole('button', { name: 'Pause changes' }));
    await waitFor(() => expect(bodies).toEqual([{ reason: 'Drift storm' }]));
  });

  it('loads the calls ledger only when opened', async () => {
    let asked = 0;
    await renderApp('/admin/settings', {
      session: 'admin',
      handlers: handlers({
        '/api/v1/platform/idp/calls': () => {
          asked += 1;
          return json({
            items: [
              {
                id: 1,
                phase: 'end',
                method: 'snapshot',
                target: null,
                actor: 'system',
                reason: 'reconcile',
                status: 'ok',
                at: NOW,
              },
            ],
            nextCursor: null,
          });
        },
      }),
    });
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Calls' });
    expect(asked).toBe(0);
    await user.click(screen.getByRole('button', { name: 'Show calls' }));
    expect(await screen.findByText('snapshot')).toBeInTheDocument();
    expect(asked).toBe(1);
  });
});
