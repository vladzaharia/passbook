import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { WORKBENCH_KEY_MAX_MS, WORKBENCH_KEY_SCOPES } from '@/shared/contracts/workbench.ts';
import { createKey, toReview } from '../../admin/api-keys/wizard-test-utils.ts';
import { json, membershipFixture, renderApp } from '../../lib/test-utils.tsx';
import { forgetTokens } from '../host/token.ts';
import { handlers } from '../shell/test-fixtures.ts';

afterEach(() => {
  forgetTokens();
  localStorage.clear();
  sessionStorage.clear();
});

const key = (over: Record<string, unknown> = {}) => ({
  id: 'k1',
  orgId: 'nw',
  name: 'CI key',
  prefix: 'abc123',
  secretPrefix: 'pb_test_abc123',
  kind: 'service',
  mode: 'test',
  roles: [],
  scopes: ['passes:read'],
  ipAllow: [],
  parentKeyId: null,
  createdBy: 'u1',
  createdByName: 'Ada Lovelace',
  createdAt: 1_700_000_000_000,
  lastUsedAt: null,
  expiresAt: Date.now() + 7 * 86_400_000,
  revokedAt: null,
  ...over,
});

const seen: { headers: Headers; url: URL }[] = [];
const keysApi = () => ({
  ...handlers(),
  '/api/v1/api-keys': (url: URL, init?: RequestInit) => {
    seen.push({ headers: new Headers(init?.headers), url });
    return json({ items: [key()], nextCursor: null, revokedCount: 0 });
  },
  '/api/v1/request-logs': () =>
    json({
      items: [
        {
          id: 'l1',
          requestId: 'r1',
          at: Date.now() - 60_000,
          method: 'GET',
          route: '/api/v1/passes',
          path: '/api/v1/passes',
          query: null,
          status: 200,
          code: null,
          durationMs: 12,
          keyId: 'k1',
          mode: 'test',
          via: null,
          client: null,
          hasBodies: false,
          resourceId: null,
          apiVersion: null,
          flags: { idempotencyKey: false, ifMatch: false, version: false },
        },
      ],
      nextCursor: null,
      capped: null,
      bodiesRecorded: true,
    }),
});

describe('Keys in the Workbench', () => {
  it('lists the org Test keys on the token, with no admin link and no mode header', async () => {
    seen.length = 0;
    await renderApp('/workbench/o/nw/keys', {
      session: 'developer',
      memberships: [membershipFixture('nw')],
      handlers: keysApi(),
    });
    expect(await screen.findByText('CI key')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Keys', level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New API key' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Ada Lovelace' })).toBeNull();
    expect(screen.getByRole('link', { name: 'CI key' })).toHaveAttribute(
      'href',
      '/workbench/o/nw/keys#k1',
    );
    const call = seen[0];
    expect(call?.headers.get('authorization')).toBe('Bearer pbtry_nw');
    expect([...(call?.headers.keys() ?? [])].some((h) => /mode/i.test(h))).toBe(false);
  });

  it('makes a capped key: Test-data scopes, a service key, 30 days at most', async () => {
    let body: Record<string, unknown> = {};
    let headers = new Headers();
    await renderApp('/workbench/o/nw/keys', {
      session: 'developer',
      memberships: [membershipFixture('nw')],
      handlers: {
        ...keysApi(),
        '/api/v1/api-keys': (_url: URL, init?: RequestInit) => {
          if (init?.method === 'POST') {
            headers = new Headers(init.headers);
            body = JSON.parse(String(init.body));
            return json({ ...key({ id: 'k2' }), secret: 'pb_test_abc123_SECRET' }, 201);
          }
          return json({ items: [], nextCursor: null, revokedCount: 0 });
        },
      },
    });
    const user = userEvent.setup();
    await screen.findByText('No API keys');
    await user.click(screen.getByRole('button', { name: 'New API key' }));
    const dialog = await screen.findByRole('dialog', { name: 'New API key' });
    // No type choice, and only the cap's days.
    expect(within(dialog).queryByText('Personal')).toBeNull();
    await user.type(within(dialog).getByLabelText(/Name/), 'CI');
    await user.click(within(dialog).getByRole('button', { name: 'Next' }));
    await within(dialog).findByRole('heading', { name: 'What it can do' });
    // No role presets, no scope outside the cap.
    expect(within(dialog).queryByText('Or a role')).toBeNull();
    await user.click(within(dialog).getByRole('radio', { name: /Custom/ }));
    const offered = within(dialog)
      .getAllByRole('checkbox')
      .map((c) => c.getAttribute('aria-label') ?? c.id);
    expect(offered.length).toBeLessThanOrEqual(WORKBENCH_KEY_SCOPES.length);
    expect(within(dialog).queryByRole('checkbox', { name: 'Manage brand' })).toBeNull();
    await toReview(user, dialog);
    await createKey(user, dialog);
    await waitFor(() => expect(body.name).toBe('CI'));
    expect(body.mode).toBe('test');
    expect(body.kind).toBe('service');
    expect(body.roles).toBeUndefined();
    expect((body.scopes as string[]).every((s) => WORKBENCH_KEY_SCOPES.includes(s))).toBe(true);
    expect(body.expiresAt).toBeLessThanOrEqual(Date.now() + WORKBENCH_KEY_MAX_MS);
    expect(typeof body.expiresAt).toBe('number');
    expect([...headers.keys()].some((h) => /mode/i.test(h))).toBe(false);
  });

  it('opens a key at its hash with its recent calls', async () => {
    await renderApp('/workbench/o/nw/keys#k1', {
      session: 'developer',
      memberships: [membershipFixture('nw')],
      handlers: {
        ...keysApi(),
        '/api/v1/api-keys/k1': () =>
          json({ ...key(), lastIpPrefix: null, childCount: 0, parent: null, replacedBy: null }),
      },
    });
    expect(await screen.findByRole('heading', { name: 'CI key', level: 2 })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Keys' }).length).toBeGreaterThan(1);
    const calls = await screen.findByRole('link', { name: /\/api\/v1\/passes/ });
    expect(calls).toHaveAttribute('href', '/workbench/o/nw/logs#l1');
  });

  it('offers no New key to a member without integrations:manage', async () => {
    await renderApp('/workbench/o/nw/keys', {
      session: 'developer',
      memberships: [membershipFixture('nw', { capabilities: ['integrations:read'] })],
      handlers: keysApi(),
    });
    expect(await screen.findByText('CI key')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New API key' })).toBeNull();
  });

  it('a sandbox lists and makes keys like an org: its person is its admin', async () => {
    await renderApp('/workbench/o/sbx/keys', {
      session: 'developer',
      handlers: {
        ...keysApi(),
        '/api/v1/api-keys': () =>
          json({ items: [key({ orgId: 'sbx' })], nextCursor: null, revokedCount: 0 }),
      },
    });
    expect(await screen.findByText('CI key')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New API key' })).toBeInTheDocument();
  });
});
