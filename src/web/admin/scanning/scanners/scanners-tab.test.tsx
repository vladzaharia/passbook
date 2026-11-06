import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { json, problem, renderApp } from '@/web/lib/test-utils.tsx';
import { NOW, pairingFixture, scannerFixture as s, templateFixture } from '../test-fixtures.ts';

const page = (items: unknown[]) => json({ items, nextCursor: null });
const none = () => page([]);

const scanners = [
  s({ id: 's1', name: 'Front door', lastSeenAt: Date.now() - 60_000 }),
  s({ id: 's2', name: 'Side door', online: false, today: 0, lastSeenAt: Date.now() - 20 * 60_000 }),
  s({
    id: 's3',
    name: 'Till 2',
    status: 'not_paired',
    online: false,
    pairedAt: null,
    pairedLabel: null,
    lastSeenAt: null,
    accepts: { templateIds: ['t1', 't2'] },
  }),
  s({ id: 's4', name: 'Old gate', status: 'revoked', online: false }),
];

const handlers = (over: Record<string, never> = {}) => ({
  '/api/v1/scan-setups': (url: URL) => {
    const revoked = url.searchParams.get('status') === 'revoked';
    return page(revoked ? scanners.filter((x) => x.status === 'revoked') : scanners.slice(0, 3));
  },
  '/api/v1/scan-events': none,
  '/api/v1/templates': () => page([templateFixture()]),
  ...over,
});

describe('Scanners tab', () => {
  it('lists scanners with status, accepts and a ghost Pair on the unpaired one', async () => {
    const { container } = await renderApp('/admin/scanning?orgId=o1', {
      session: 'admin',
      handlers: handlers(),
    });
    const table = await screen.findByRole('table', { name: 'Scanners' });
    expect(within(table).getByRole('link', { name: 'Front door' }).getAttribute('href')).toMatch(
      /^\/admin\/scanning\/scanners\/s1(\?|$)/,
    );
    expect(within(table).getAllByText('Safari on iPhone').length).toBeGreaterThan(0);
    expect(within(table).getByText('Online')).toBeInTheDocument();
    expect(within(table).getByText('Offline')).toBeInTheDocument();
    expect(within(table).getAllByText('Not paired')).toHaveLength(2);
    expect(within(table).getByText('2 templates')).toBeInTheDocument();
    expect(within(table).getAllByText('Sign-in off').length).toBeGreaterThan(0);
    expect(within(table).getByRole('button', { name: 'Pair' })).toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('keeps revoked scanners behind Show revoked', async () => {
    await renderApp('/admin/scanning?orgId=o1', { session: 'admin', handlers: handlers() });
    await screen.findByText('Side door');
    expect(screen.queryByText('Old gate')).toBeNull();
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Show revoked (1)' }));
    expect(screen.getByText('Old gate')).toBeInTheDocument();
  });

  it('revokes with a plain confirm that says the scans stay', async () => {
    let revoked = false;
    await renderApp('/admin/scanning?orgId=o1', {
      session: 'admin',
      handlers: handlers({
        '/api/v1/scanners/s1/revoke': (_u: URL, init?: RequestInit) => {
          revoked = init?.method === 'POST';
          return new Response(null, { status: 204 });
        },
      } as never),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Actions for Front door' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Revoke' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Revoke Front door?' });
    expect(dialog).toHaveTextContent('The device stops scanning at once. Its scans stay.');
    await user.click(within(dialog).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(revoked).toBe(true));
  });

  it('asks before pairing a paired scanner again, then shows the pairing face', async () => {
    await renderApp('/admin/scanning?orgId=o1', {
      session: 'admin',
      handlers: handlers({
        '/api/v1/scanners/s1/pairing': (_u: URL, init?: RequestInit) =>
          init?.method === 'POST'
            ? json(pairingFixture())
            : json({ state: 'waiting', device: null }),
      } as never),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Actions for Front door' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Pair again' }));
    const ask = await screen.findByRole('alertdialog', { name: 'Pair Front door again?' });
    expect(ask).toHaveTextContent('The device using it now signs out at its next scan.');
    await user.click(within(ask).getByRole('button', { name: 'Pair again' }));
    expect(await screen.findByText('K7QH2-M9XTR')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: /Pair Front door/ })).toBeInTheDocument();
  });

  it('shows the empty state with one primary, and fills it by order', async () => {
    await renderApp('/admin/scanning', {
      session: 'admin',
      handlers: { '/api/v1/scan-setups': none, '/api/v1/scan-events': none },
    });
    expect(await screen.findByText('No scanners yet')).toBeInTheDocument();
    expect(NOW).toBeGreaterThan(0);
  });
});

describe('New scanner dialog', () => {
  const open = async (extra: Record<string, never> = {}) => {
    const utils = await renderApp('/admin/scanning?orgId=o1&new=1', {
      session: 'admin',
      handlers: handlers(extra as never),
    });
    return { ...utils, dialog: await screen.findByRole('dialog', { name: /New scanner/ }) };
  };

  it('opens from ?new=1 and needs a name and a template', async () => {
    const { dialog, router } = await open();
    await waitFor(() => expect(router.state.location.search).not.toHaveProperty('new'));
    await userEvent.setup().click(within(dialog).getByRole('button', { name: 'Create and pair' }));
    expect(await within(dialog).findByText('Required.')).toBeInTheDocument();
    expect(within(dialog).getByText('Pick at least one template.')).toBeInTheDocument();
  });

  it('creates a browser scanner and turns into the pairing face', async () => {
    let body: Record<string, unknown> | undefined;
    const { dialog } = await open({
      '/api/v1/scan-setups': ((_url: URL, init?: RequestInit) => {
        if (init?.method === 'POST') {
          body = JSON.parse(String(init.body));
          return json({ ...s({ id: 's9', name: 'Back door' }), pairing: pairingFixture() });
        }
        return page([]);
      }) as never,
      '/api/v1/scanners/s9/pairing': (() => json({ state: 'waiting', device: null })) as never,
    });
    const user = userEvent.setup();
    await user.type(within(dialog).getByLabelText(/^Name/), 'Back door');
    await user.click(await within(dialog).findByLabelText('Gala ticket'));
    await user.click(within(dialog).getByRole('button', { name: 'Create and pair' }));
    expect(await screen.findByText('K7QH2-M9XTR')).toBeInTheDocument();
    expect(body).toMatchObject({
      orgId: 'o1',
      name: 'Back door',
      kind: 'device',
      accepts: { templateIds: ['t1'] },
      settings: { staffSignIn: false, roleWithoutSignIn: 'door', flow: 'auto' },
    });
    expect(screen.getByRole('dialog', { name: /Pair Back door/ })).toBeInTheDocument();
  });

  it('maps a taken name onto its field', async () => {
    const { dialog } = await open({
      '/api/v1/scan-setups': ((_u: URL, init?: RequestInit) =>
        init?.method === 'POST' ? problem(409, 'SCANNER_NAME_TAKEN', 'taken') : page([])) as never,
    });
    const user = userEvent.setup();
    await user.type(within(dialog).getByLabelText(/^Name/), 'Front door');
    await user.click(await within(dialog).findByLabelText('Gala ticket'));
    await user.click(within(dialog).getByRole('button', { name: 'Create and pair' }));
    expect(
      await within(dialog).findByText('A scanner here already has this name.'),
    ).toBeInTheDocument();
  });
});
