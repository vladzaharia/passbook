import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { json, membershipFixture, renderApp } from '@/web/lib/test-utils.tsx';
import { createKey, next, toReview } from './wizard-test-utils.ts';

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
    await user.click(screen.getByRole('option', { name: '1 year' }));
    await user.click(within(dialog).getByRole('radio', { name: /Personal/ }));
    await user.click(within(dialog).getByRole('combobox', { name: /Expires/ }));
    expect(screen.queryByRole('option', { name: 'Never' })).toBeNull();
    expect(screen.queryByRole('option', { name: '1 year' })).toBeNull();
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      '7 days',
      '30 days',
      '90 days',
    ]);
    await user.click(screen.getByRole('option', { name: '30 days' }));
    await toReview(user, dialog);
    expect(within(dialog).getByText('Personal, acts as you')).toBeInTheDocument();
    await createKey(user, dialog);
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
    await next(user, dialog);
    expect(
      await within(dialog).findByRole('checkbox', { name: 'Read passes' }),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole('radio', { name: 'Pass operator' }));
    expect(within(dialog).queryByRole('checkbox', { name: 'Read passes' })).toBeNull();
    await next(user, dialog);
    await next(user, dialog);
    expect(
      within(await within(dialog).findByRole('region', { name: 'Access' })).getByText(
        'Pass operator',
      ),
    ).toBeInTheDocument();
    await createKey(user, dialog);
    await waitFor(() => expect(body.roles).toEqual(['pass_operator']));
    expect(body.scopes).toEqual([]);
    expect(body.kind).toBe('service');
  });

  it('Enter advances a valid step and stays put on an invalid one', async () => {
    const { user, dialog } = await openOrgDialog(() => created());
    await user.type(within(dialog).getByLabelText(/Name/), '{Enter}');
    expect(
      await within(dialog).findByRole('heading', { name: 'What it can do' }),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Back' }));
    await user.clear(within(dialog).getByLabelText(/Name/));
    await user.type(within(dialog).getByLabelText(/Name/), '{Enter}');
    expect(within(dialog).getByRole('heading', { name: 'Name the key' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('allows going back only to done steps', async () => {
    const { user, dialog } = await openOrgDialog(() => created());
    const rail = within(dialog).getByRole('navigation', { name: 'Steps' });
    expect(within(rail).queryByRole('button')).toBeNull();
    await next(user, dialog);
    await user.click(within(rail).getByRole('button', { name: /Basics/ }));
    expect(
      await within(dialog).findByRole('heading', { name: 'Name the key' }),
    ).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/Name/)).toHaveValue('Mine');
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
