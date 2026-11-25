import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { json, membershipFixture, renderApp } from '@/web/lib/test-utils.tsx';

const DAY = 86_400_000;
const created = (over: Record<string, unknown> = {}) => ({
  id: 'k1',
  orgId: 'o1',
  name: 'Mine',
  prefix: 'abc12345',
  secretPrefix: 'pbp_test_demo0001',
  scopes: ['passes:read'],
  createdBy: 'u1',
  createdByName: null,
  createdAt: 1_700_000_000_000,
  lastUsedAt: null,
  expiresAt: null,
  revokedAt: null,
  secret: 'pbp_test_demo0001_demo',
  ...over,
});

async function openOrgDialog(onPost: (body: Record<string, unknown>) => unknown) {
  await renderApp('/admin/o/o1/api-keys', {
    session: 'admin',
    memberships: [membershipFixture('o1', { orgName: 'North' })],
    handlers: {
      '/api/v1/api-keys': (_u, init) => {
        if (init?.method !== 'POST') return json({ items: [], nextCursor: null, revokedCount: 0 });
        return json(onPost(JSON.parse(String(init.body))), 201);
      },
    },
  });
  const user = userEvent.setup();
  await screen.findByText(/^No (active )?API keys$/);
  await user.click(screen.getByRole('button', { name: 'New API key' }));
  const dialog = await screen.findByRole('dialog', { name: 'New API key' });
  await user.type(within(dialog).getByLabelText(/Name/), 'Mine');
  return { user, dialog };
}

describe('key type, role and expiry', () => {
  it('a personal key offers only short expiries and is sent as personal', async () => {
    let body: Record<string, unknown> = {};
    const { user, dialog } = await openOrgDialog((b) => {
      body = b;
      return created({ kind: 'personal' });
    });
    await user.click(within(dialog).getByRole('combobox', { name: /Expires/ }));
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      '7 days',
      '30 days',
      '90 days',
      '6 months',
      '1 year',
      'Never',
    ]);
    expect(screen.getByRole('option', { name: 'Never' })).toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: '1 year' }));
    await user.click(within(dialog).getByRole('combobox', { name: 'Type' }));
    await user.click(await screen.findByRole('option', { name: /Personal/ }));
    await user.click(within(dialog).getByRole('combobox', { name: /Expires/ }));
    expect(screen.queryByRole('option', { name: 'Never' })).toBeNull();
    expect(screen.queryByRole('option', { name: '1 year' })).toBeNull();
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      '7 days',
      '30 days',
      '90 days',
    ]);
    await user.click(screen.getByRole('option', { name: '30 days' }));
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));
    const review = await screen.findByRole('alertdialog', { name: 'Review personal key' });
    expect(within(review).getByText(/personal, acts as you/)).toBeInTheDocument();
    await user.click(within(review).getByRole('button', { name: 'Create key' }));
    await waitFor(() => expect(body.kind).toBe('personal'));
    expect(body.expiresAt).toBeGreaterThan(Date.now() + 29 * DAY);
    expect(body.expiresAt).toBeLessThan(Date.now() + 31 * DAY);
  });

  it('a role replaces the scope list and is sent as roles', async () => {
    let body: Record<string, unknown> = {};
    const { user, dialog } = await openOrgDialog((b) => {
      body = b;
      return created({ scopes: [], roles: ['pass_operator'] });
    });
    expect(within(dialog).getByRole('checkbox', { name: 'Read passes' })).toBeInTheDocument();
    await user.click(within(dialog).getByRole('combobox', { name: 'Access' }));
    await user.click(await screen.findByRole('option', { name: 'Role: Pass operator' }));
    expect(within(dialog).queryByRole('checkbox', { name: 'Read passes' })).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));
    const review = await screen.findByRole('alertdialog');
    expect(within(review).getByText(/Permissions: Pass operator/)).toBeInTheDocument();
    await user.click(within(review).getByRole('button', { name: 'Create key' }));
    await waitFor(() => expect(body.roles).toEqual(['pass_operator']));
    expect(body.scopes).toEqual([]);
    expect(body.kind).toBe('service');
  });

  it('lists the start of each secret, the kind and the role of a key', async () => {
    await renderApp('/admin/o/o1/api-keys', {
      session: 'admin',
      memberships: [membershipFixture('o1', { orgName: 'North' })],
      handlers: {
        '/api/v1/api-keys': () =>
          json({
            items: [
              created({
                id: 'a',
                name: 'Mine',
                kind: 'personal',
                roles: ['read_only'],
                scopes: [],
              }),
              created({ id: 'b', name: 'Old', secretPrefix: undefined, prefix: 'zzz99999' }),
            ],
            nextCursor: null,
            revokedCount: 0,
          }),
      },
    });
    expect(await screen.findByText('pbp_test_demo0001')).toBeInTheDocument();
    expect(screen.getByText('Personal')).toBeInTheDocument();
    expect(screen.getByText('Read only')).toBeInTheDocument();
    expect(screen.getByText('wlt_zzz99999')).toBeInTheDocument();
  });
});
