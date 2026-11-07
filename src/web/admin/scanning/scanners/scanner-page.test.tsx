import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { resetModeForTests } from '@/web/lib/mode.ts';
import { json, problem, renderApp } from '@/web/lib/test-utils.tsx';
import { scannerFixture as s, templateFixture } from '../test-fixtures.ts';

const page = (items: unknown[]) => json({ items, nextCursor: null });
const none = () => page([]);
const base = {
  '/api/v1/scan-events': none,
  '/api/v1/templates': () => page([templateFixture()]),
};

afterEach(() => resetModeForTests());

describe('Scanner page', () => {
  it('shows status, device and settings in a two-pane page', async () => {
    const { container } = await renderApp('/admin/scanning/scanners/s1', {
      session: 'admin',
      handlers: { ...base, '/api/v1/scan-setups/s1': () => json(s()) },
    });
    expect(
      await screen.findByRole('heading', { name: 'Front door', level: 1 }),
    ).toBeInTheDocument();
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumbs).getByRole('link', { name: 'Scanning' })).toHaveAttribute(
      'href',
      '/admin/scanning',
    );
    expect(screen.getByText('Online')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Scans' }).getAttribute('href')).toContain('tab=scans');
    expect(screen.getByRole('link', { name: 'Scans' }).getAttribute('href')).toContain(
      'scannerId=s1',
    );
    expect(screen.getByRole('button', { name: 'Pair again' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Go live' })).toBeNull();
    const device = screen.getByRole('heading', { name: 'Device' }).closest('div');
    expect(device?.parentElement).toHaveTextContent('Safari on iPhone');
    expect((await axe(container)).violations).toEqual([]);
  });

  it('saves changed settings through the SaveBar', async () => {
    let patch: Record<string, unknown> | undefined;
    await renderApp('/admin/scanning/scanners/s1', {
      session: 'admin',
      handlers: {
        ...base,
        '/api/v1/scan-setups/s1': (_u, init) => {
          if (init?.method === 'PATCH') {
            patch = JSON.parse(String(init.body));
            return new Response(null, { status: 204 });
          }
          return json(s());
        },
      },
    });
    const user = userEvent.setup();
    const name = await screen.findByLabelText(/^Name/);
    await user.clear(name);
    await user.type(name, 'Main door');
    await user.click(await screen.findByRole('button', { name: /Save/ }));
    await waitFor(() => expect(patch).toMatchObject({ name: 'Main door' }));
    expect(patch?.settings).toMatchObject({ flow: 'auto', letInAgain: 'anyone' });
  });

  it('goes live from a Test scanner after a confirm that names what changes', async () => {
    let live = false;
    await renderApp('/admin/scanning/scanners/s1', {
      session: 'admin',
      handlers: {
        ...base,
        '/api/v1/scan-setups/s1': () => json(s({ mode: 'test' })),
        '/api/v1/scanners/s1/mode': (_u, init) => {
          live = JSON.parse(String(init?.body)).mode === 'live';
          return new Response(null, { status: 204 });
        },
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Go live' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Make Front door live?' });
    expect(dialog).toHaveTextContent(
      'It starts accepting live passes and stops accepting test ones.',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Go live' }));
    await waitFor(() => expect(live).toBe(true));
  });

  it('shows a till token once and gates Done on "I saved the token"', async () => {
    await renderApp('/admin/scanning/scanners/s1', {
      session: 'admin',
      handlers: {
        ...base,
        '/api/v1/scan-setups/s1': () => json(s({ kind: 'terminal', pairedLabel: null })),
        '/api/v1/scanners/s1/token': () =>
          json({ token: 'wls_ab12cd34_secretsecretsecret', expiresAt: Date.now() + 1e9 }),
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'More' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Replace token' }));
    const dialog = await screen.findByRole('dialog', { name: /token/ });
    expect(
      await within(dialog).findByText('Copy the secret now. It is not shown again.'),
    ).toBeInTheDocument();
    const done = within(dialog).getByRole('button', { name: 'Done' });
    expect(done).toBeDisabled();
    await user.click(within(dialog).getByRole('checkbox', { name: 'I saved the token' }));
    await user.click(done);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByText(/wls_ab12cd34/)).toBeNull();
  });

  it('keeps a revoked scanner read-only', async () => {
    await renderApp('/admin/scanning/scanners/s1', {
      session: 'admin',
      handlers: { ...base, '/api/v1/scan-setups/s1': () => json(s({ status: 'revoked' })) },
    });
    expect(await screen.findByText('Revoked')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pair again' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Revoke' })).toBeNull();
    expect(await screen.findByLabelText(/^Name/)).toBeDisabled();
  });

  it('shows not found for a scanner that is not there', async () => {
    await renderApp('/admin/scanning/scanners/nope', {
      session: 'admin',
      handlers: {
        ...base,
        '/api/v1/scan-setups/nope': () => problem(404, 'not_found', 'No scanner.'),
      },
    });
    expect(await screen.findByText(/scanner/i, { selector: 'h1, h2, p' })).toBeInTheDocument();
  });
});
