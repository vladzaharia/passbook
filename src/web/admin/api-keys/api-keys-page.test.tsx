import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { json, problem, renderApp } from '@/web/lib/test-utils.tsx';
import { keyState } from './api-keys-page.tsx';

const key = (over: Record<string, unknown> = {}) => ({
  id: 'k1',
  orgId: null,
  name: 'CI key',
  prefix: 'abc123',
  scopes: ['passes:read'],
  createdBy: 'u1',
  createdAt: 1_700_000_000_000,
  lastUsedAt: null,
  expiresAt: null,
  revokedAt: null,
  ...over,
});

describe('keyState', () => {
  it('prefers revoked over expired', () => {
    const base = key() as never;
    expect(keyState({ ...(base as object), revokedAt: 1, expiresAt: 1 } as never, 10)).toBe(
      'revoked',
    );
    expect(keyState({ ...(base as object), expiresAt: 5 } as never, 10)).toBe('expired');
    expect(keyState(base, 10)).toBe('active');
  });
});

describe('api keys page', () => {
  it('lists keys, accessible', async () => {
    const { container } = await renderApp('/admin/api-keys', {
      session: 'admin',
      handlers: {
        '/api/v1/api-keys': () =>
          json({ items: [key(), key({ id: 'k2', name: 'Old', revokedAt: 5 })] }),
      },
    });
    expect(await screen.findByRole('cell', { name: 'CI key' })).toBeInTheDocument();
    expect(screen.getAllByText('wlt_abc123', { exact: false })[0]).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Revoke/ })).toHaveLength(1);
    expect((await axe(container)).violations).toEqual([]);
  });

  it('shows empty and error states', async () => {
    await renderApp('/admin/api-keys', {
      session: 'admin',
      handlers: { '/api/v1/api-keys': () => json({ items: [] }) },
    });
    expect(await screen.findByText('No API keys')).toBeInTheDocument();
  });

  it('shows an error state', async () => {
    await renderApp('/admin/api-keys', {
      session: 'admin',
      handlers: { '/api/v1/api-keys': () => problem(500, 'x', 'x') },
    });
    expect(await screen.findByText('Server error. Try again.')).toBeInTheDocument();
  });

  it('creates a key and shows the secret once', async () => {
    let body: Record<string, unknown> = {};
    await renderApp('/admin/api-keys', {
      session: 'admin',
      handlers: {
        '/api/v1/api-keys': (_u, init) => {
          if (init?.method === 'POST') {
            body = JSON.parse(String(init.body));
            return json({ ...key(), secret: 'wlt_abc123_SECRETVALUE' }, 201);
          }
          return json({ items: [] });
        },
      },
    });
    const user = userEvent.setup();
    await user.click((await screen.findAllByRole('button', { name: 'New key' }))[0]!);
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(await within(dialog).findByText('Required.')).toBeInTheDocument();
    expect(within(dialog).getByText('Pick at least one scope.')).toBeInTheDocument();

    await user.type(within(dialog).getByLabelText(/Name/), 'CI key');
    await user.click(within(dialog).getByRole('checkbox', { name: 'passes:read' }));
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(body.name).toBe('CI key'));
    expect(body.scopes).toEqual(['passes:read']);
    expect(body.orgId).toBeNull();
    expect(typeof body.expiresAt).toBe('number');
    expect(await screen.findByText('wlt_abc123_SECRETVALUE')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy api key secret' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() =>
      expect(screen.queryByText('wlt_abc123_SECRETVALUE')).not.toBeInTheDocument(),
    );
  });

  it('shows a server error in the create dialog', async () => {
    await renderApp('/admin/api-keys', {
      session: 'admin',
      handlers: {
        '/api/v1/api-keys': (_u, init) =>
          init?.method === 'POST'
            ? problem(409, 'conflict', 'A key with this name exists.')
            : json({ items: [] }),
      },
    });
    const user = userEvent.setup();
    await user.click((await screen.findAllByRole('button', { name: 'New key' }))[0]!);
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/Name/), 'x');
    await user.click(within(dialog).getByRole('checkbox', { name: 'passes:read' }));
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(await within(dialog).findByText('A key with this name exists.')).toBeInTheDocument();
  });

  it('revokes after confirmation', async () => {
    let revoked = false;
    await renderApp('/admin/api-keys', {
      session: 'admin',
      handlers: {
        '/api/v1/api-keys': () => json({ items: [key()] }),
        '/api/v1/api-keys/k1': (_u, init) => {
          if (init?.method === 'DELETE') revoked = true;
          return json({ ok: true });
        },
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Revoke/ }));
    const dialog = await screen.findByRole('alertdialog');
    expect(revoked).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(revoked).toBe(true));
  });
});
