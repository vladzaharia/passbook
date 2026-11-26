import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { json, renderApp } from '@/web/lib/test-utils.tsx';
import { createKey, next, toReview } from './wizard-test-utils.ts';

afterEach(() => vi.unstubAllGlobals());

const key = (over: Record<string, unknown> = {}) => ({
  id: 'k1',
  orgId: null,
  kind: 'platform',
  name: 'Ops read',
  prefix: 'abc123',
  secretPrefix: 'pbo_abc123',
  scopes: ['platform:read'],
  roles: [],
  createdBy: 'u1',
  createdByName: 'Ada Lovelace',
  createdAt: 1_700_000_000_000,
  lastUsedAt: null,
  expiresAt: 1_900_000_000_000,
  ipAllow: ['203.0.113.0/24'],
  revokedAt: null,
  ...over,
});
const page = (items: unknown[]) => json({ items, nextCursor: null, revokedCount: 0 });

async function openAccess(amr: 'oidc' | 'breakglass' = 'oidc', body?: (b: unknown) => void) {
  const view = await renderApp('/admin/platform/api-keys', {
    session: 'admin',
    amr,
    handlers: {
      '/api/v1/api-keys': (_u, init) => {
        if (init?.method === 'POST') {
          body?.(JSON.parse(String(init.body)));
          return json({ ...key(), secret: 'pbo_abc123_S' }, 201);
        }
        return page([key(), key({ id: 'k2', name: 'Org sync', scopes: ['passes:read'] })]);
      },
    },
  });
  const user = userEvent.setup();
  await screen.findByText('Ops read');
  await user.click(screen.getByRole('button', { name: 'New API key' }));
  const dialog = await screen.findByRole('dialog');
  await user.type(within(dialog).getByLabelText(/Name/), 'Ops');
  await next(user, dialog);
  await within(dialog).findByRole('heading', { name: 'What it can do' });
  return { view, user, dialog };
}

describe('platform keys in the wizard', () => {
  it('lists an Access column', async () => {
    await renderApp('/admin/platform/api-keys', {
      session: 'admin',
      handlers: {
        '/api/v1/api-keys': () =>
          page([key(), key({ id: 'k2', name: 'Org sync', scopes: ['passes:read'] })]),
      },
    });
    await screen.findByText('Ops read');
    expect(screen.getByRole('columnheader', { name: 'Access' })).toBeInTheDocument();
    expect(screen.getAllByText('Platform').length).toBeGreaterThan(0);
    expect(screen.getByText('All organizations')).toBeInTheDocument();
  });

  it('swaps the scope list with the switch and says what went', async () => {
    const { user, dialog } = await openAccess();
    expect(within(dialog).getByRole('checkbox', { name: 'Read passes' })).toBeChecked();
    await user.click(within(dialog).getByRole('checkbox', { name: 'Assign holders' }));
    await user.click(within(dialog).getByRole('radio', { name: 'Platform' }));
    expect(within(dialog).getByRole('checkbox', { name: 'Read the platform' })).toBeChecked();
    expect(within(dialog).queryByRole('checkbox', { name: 'Read passes' })).toBeNull();
    expect(within(dialog).getByText('Removed: Assign holders.')).toBeInTheDocument();
    expect(within(dialog).getByRole('checkbox', { name: 'Polaris ID groups' })).toBeInTheDocument();
    await user.click(within(dialog).getByRole('radio', { name: 'All organizations' }));
    expect(within(dialog).getByRole('checkbox', { name: 'Read passes' })).toBeChecked();
  });

  it('mints a Platform key with platform scopes only, Live, with a short expiry for a write scope', async () => {
    let body: Record<string, unknown> = {};
    const { user, dialog } = await openAccess('oidc', (b) => {
      body = b as Record<string, unknown>;
    });
    await user.click(within(dialog).getByRole('radio', { name: 'Platform' }));
    await user.click(within(dialog).getByRole('checkbox', { name: 'Polaris ID groups' }));
    await next(user, dialog);
    await user.type(within(dialog).getByLabelText(/Allowed IPs/), '203.0.113.0/24{Enter}');
    expect(within(dialog).queryByRole('radiogroup', { name: 'Mode' })).toBeNull();
    await toReview(user, dialog);
    expect(within(dialog).getByText(/Freeze Polaris ID/)).toBeInTheDocument();
    await createKey(user, dialog);
    await waitFor(() => expect(body.kind).toBe('platform'));
    expect(body.scopes).toEqual(['platform:read', 'platform:groups']);
    expect(body.mode).toBe('live');
    const days = ((body.expiresAt as number) - Date.now()) / 86_400_000;
    expect(days).toBeLessThanOrEqual(30);
  });

  it('offers 90 days for a read-only Platform key and 7 or 30 once a write scope is ticked', async () => {
    const { user, dialog } = await openAccess();
    await user.click(within(dialog).getByRole('radio', { name: 'Platform' }));
    await user.click(within(dialog).getByRole('button', { name: 'Back' }));
    const expires = within(dialog).getByRole('combobox', { name: /Expires/ });
    await user.click(expires);
    expect(screen.getByRole('option', { name: '90 days' })).toBeInTheDocument();
  });

  it('blocks a break-glass session from making a Platform key', async () => {
    const { user, dialog } = await openAccess('breakglass');
    await user.click(within(dialog).getByRole('radio', { name: 'Platform' }));
    expect(
      within(dialog).getByText('Sign in with Polaris ID to make a platform key.'),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Next' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect((await axe(dialog)).violations).toEqual([]);
  });
});
