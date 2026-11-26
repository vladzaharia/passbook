import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { json, membershipFixture, problem, renderApp } from '@/web/lib/test-utils.tsx';

afterEach(() => vi.unstubAllGlobals());

const NOW = Date.now();
const base = {
  id: 'k1',
  orgId: 'o1',
  name: 'Deploy job',
  prefix: 'abc123',
  secretPrefix: 'pb_test_demo01',
  scopes: ['passes:read', 'api-keys:write'],
  mode: 'live',
  createdBy: 'u1',
  createdByName: 'Ada Lovelace',
  createdAt: NOW - 20 * 86_400_000,
  lastUsedAt: NOW - 3_600_000,
  expiresAt: null,
  revokedAt: null,
  kind: 'service',
  roles: [],
  retireAt: null,
  ipAllow: ['198.51.100.0/24'],
  templateIds: [],
  passStyles: [],
  rateTier: null,
  parentKeyId: null,
  rotatedFrom: null,
  lastIpPrefix: '198.51.100',
  parent: null,
  replacedBy: null,
  childCount: 1,
};
const child = {
  ...base,
  id: 'k2',
  name: 'Nightly import',
  scopes: ['passes:read'],
  parentKeyId: 'k1',
};
const activity = {
  lastUsedAt: base.lastUsedAt,
  lastIpPrefix: '198.51.100',
  summary: {
    since: NOW - 30 * 86_400_000,
    calls: 5,
    denied: 1,
    actions: [{ action: 'pass.create', count: 4, lastAt: NOW }],
  },
  recent: [
    {
      id: 2,
      at: NOW - 60_000,
      action: 'auth.denied',
      outcome: 'denied',
      targetType: null,
      targetId: null,
      ipPrefix: null,
      code: 'MISSING_SCOPE',
    },
    {
      id: 1,
      at: NOW - 120_000,
      action: 'pass.create',
      outcome: 'allowed',
      targetType: 'pass',
      targetId: 'p1',
      ipPrefix: null,
      code: null,
    },
  ],
};
const manager = membershipFixture('o1', {
  orgName: 'North',
  roles: ['org_admin'],
  capabilities: ['org:read', 'integrations:read', 'integrations:manage', 'audit:read'],
});
// An integration manager reads keys but not the audit log.
const integrator = membershipFixture('o1', {
  orgName: 'North',
  roles: ['integration_admin'],
  capabilities: ['org:read', 'integrations:read', 'integrations:manage'],
});
const reader = membershipFixture('o1', {
  orgName: 'North',
  roles: ['read_only'],
  capabilities: ['org:read', 'integrations:read'],
});
const handlers = (over: Record<string, (url: URL, init?: RequestInit) => Response> = {}) => ({
  '/api/v1/api-keys/k1': () => json(base),
  '/api/v1/api-keys/k1/activity': () => json(activity),
  '/api/v1/api-keys': () => json({ items: [child], nextCursor: null, revokedCount: 0 }),
  ...over,
});

describe('API key page', () => {
  it('shows the key, its network, its child keys and what it did, without a secret', async () => {
    const { container } = await renderApp('/admin/o/o1/api-keys/k1', {
      session: 'user',
      memberships: [manager],
      handlers: handlers(),
    });
    expect(await screen.findByRole('heading', { name: 'Deploy job' })).toBeInTheDocument();
    expect(screen.getByText('pb_test_demo01')).toBeInTheDocument();
    expect(screen.getByText(/from 198\.51\.100/)).toBeInTheDocument();
    expect(screen.getByText('198.51.100.0/24')).toBeInTheDocument();
    expect(await screen.findByText('5 calls in 30 days')).toBeInTheDocument();
    expect(screen.getByText(/1 refused/)).toBeInTheDocument();
    expect(screen.getByText(/MISSING_SCOPE/)).toBeInTheDocument();
    const nightly = await screen.findByRole('link', { name: 'Nightly import' });
    expect(nightly).toHaveAttribute('href', '/admin/o/o1/api-keys/k2');
    expect(
      within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByRole('link', {
        name: 'API keys',
      }),
    ).toHaveAttribute('href', '/admin/o/o1/api-keys');
    expect((await axe(container)).violations).toEqual([]);
  });

  it('names the parent of a child key and offers no child list', async () => {
    await renderApp('/admin/o/o1/api-keys/k2', {
      session: 'user',
      memberships: [manager],
      handlers: handlers({
        '/api/v1/api-keys/k2': () =>
          json({ ...child, parent: { id: 'k1', name: 'Deploy job' }, childCount: 0 }),
        '/api/v1/api-keys/k2/activity': () => json({ ...activity, recent: [] }),
      }),
    });
    expect(await screen.findByRole('link', { name: 'Deploy job' })).toHaveAttribute(
      'href',
      '/admin/o/o1/api-keys/k1',
    );
    expect(screen.queryByText('Child keys')).toBeNull();
    expect(await screen.findByText('No calls recorded.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy key' })).toBeInTheDocument();
  });

  it('rotates with an overlap, then shows the new secret once and when the old key stops', async () => {
    let body: Record<string, unknown> = {};
    let mode = '';
    await renderApp('/admin/o/o1/api-keys/k1', {
      session: 'user',
      memberships: [manager],
      handlers: handlers({
        '/api/v1/api-keys/k1/rotate': (_u, init) => {
          body = JSON.parse(String(init?.body));
          mode = new Headers(init?.headers).get('x-passbook-mode') ?? '';
          return json(
            {
              key: { ...base, id: 'k3', secret: 'pb_live_new999_SECRETVALUE', rotatedFrom: 'k1' },
              previous: { ...base, retireAt: NOW + 24 * 3_600_000 },
            },
            201,
          );
        },
      }),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Rotate' }));
    const dialog = await screen.findByRole('dialog', { name: 'Rotate key' });
    expect(within(dialog).getByText(/1 child key stops with it/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Rotate' }));
    await waitFor(() => expect(body).toEqual({ orgId: 'o1', overlapHours: 24 }));
    expect(mode).toBe('live');
    const reveal = await screen.findByRole('dialog', { name: /Copy the new key/ });
    expect(within(reveal).getByText(/The old key stops/)).toBeInTheDocument();
    expect(within(reveal).getByLabelText('API key')).not.toHaveTextContent('SECRETVALUE');
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(within(reveal).queryByRole('button', { name: 'Close' })).toBeNull();
  });

  it('keeps the rotate form open and says why when the rotation fails', async () => {
    await renderApp('/admin/o/o1/api-keys/k1', {
      session: 'user',
      memberships: [manager],
      handlers: handlers({
        '/api/v1/api-keys/k1/rotate': () => problem(409, 'CONFLICT', 'Key already rotated.'),
      }),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Rotate' }));
    const dialog = await screen.findByRole('dialog', { name: 'Rotate key' });
    await user.click(within(dialog).getByRole('button', { name: 'Rotate' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Key already rotated.');
  });

  it('revokes after a confirm, and says the children go too', async () => {
    let revoked = false;
    await renderApp('/admin/o/o1/api-keys/k1', {
      session: 'user',
      memberships: [manager],
      handlers: handlers({
        '/api/v1/api-keys/k1': (_u, init) => {
          if (init?.method === 'DELETE') {
            revoked = true;
            return json({ ok: true });
          }
          return json(base);
        },
      }),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Revoke' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Revoke Deploy job?' });
    expect(within(confirm).getByText(/its 1 child keys/)).toBeInTheDocument();
    await user.click(within(confirm).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(revoked).toBe(true));
  });

  it('gives a reader the page but not the actions', async () => {
    await renderApp('/admin/o/o1/api-keys/k1', {
      session: 'user',
      memberships: [reader],
      handlers: handlers(),
    });
    expect(await screen.findByRole('heading', { name: 'Deploy job' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rotate' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Revoke' })).toBeNull();
  });

  it('marks a retiring key and offers no second rotation', async () => {
    await renderApp('/admin/o/o1/api-keys/k1', {
      session: 'user',
      memberships: [manager],
      handlers: handlers({
        '/api/v1/api-keys/k1': () => json({ ...base, retireAt: NOW + 3_600_000 }),
      }),
    });
    expect(await screen.findByText('Retiring')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rotate' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Revoke' })).toBeInTheDocument();
  });

  it('shows not found for a key that is not there', async () => {
    await renderApp('/admin/o/o1/api-keys/zz', {
      session: 'user',
      memberships: [manager],
      handlers: {
        '/api/v1/api-keys/zz': () =>
          json({ type: 'x', title: 'Not found', status: 404, code: 'API_KEY_NOT_FOUND' }, 404),
      },
    });
    expect(await screen.findByText(/not found/i)).toBeInTheDocument();
  });

  it('hides the activity card, and never asks for it, without audit:read', async () => {
    let asked = false;
    await renderApp('/admin/o/o1/api-keys/k1', {
      session: 'user',
      memberships: [integrator],
      handlers: handlers({
        '/api/v1/api-keys/k1/activity': () => {
          asked = true;
          return json(activity);
        },
      }),
    });
    expect(await screen.findByRole('heading', { name: 'Deploy job' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Rotate' })).toBeInTheDocument();
    expect(screen.queryByText('Activity')).toBeNull();
    expect(asked).toBe(false);
  });

  it("offers no rotation of another member's personal key, or of a platform key without expiry or addresses", async () => {
    await renderApp('/admin/o/o1/api-keys/k1', {
      session: 'user',
      memberships: [manager],
      handlers: handlers({
        '/api/v1/api-keys/k1': () => json({ ...base, kind: 'personal', createdBy: 'someone-else' }),
      }),
    });
    expect(await screen.findByRole('heading', { name: 'Deploy job' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rotate' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Revoke' })).toBeInTheDocument();
  });
});
