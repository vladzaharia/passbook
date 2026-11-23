import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { json, membershipFixture, renderApp } from '@/web/lib/test-utils.tsx';

async function openDialog(over: Parameters<typeof membershipFixture>[1] = {}) {
  await renderApp('/admin/o/o1/api-keys', {
    session: 'admin',
    memberships: [membershipFixture('o1', { orgName: 'North', ...over })],
    handlers: { '/api/v1/api-keys': () => json({ items: [], nextCursor: null, revokedCount: 0 }) },
  });
  const user = userEvent.setup();
  await screen.findByText(/^No (active )?API keys$/);
  await user.click(screen.getByRole('button', { name: 'New API key' }));
  const dialog = await screen.findByRole('dialog', { name: 'New API key' });
  return { user, dialog, scopes: within(dialog).getByRole('group', { name: /Scopes/ }) };
}

const ticked = (scopes: HTMLElement) =>
  within(scopes)
    .getAllByRole('checkbox')
    .filter((c) => c.getAttribute('aria-checked') === 'true' || (c as HTMLInputElement).checked)
    .map((c) => c.id);

describe('scope presets', () => {
  it('tick the preset scopes and show it selected while the list matches', async () => {
    const { user, scopes } = await openDialog();
    const till = within(scopes).getByRole('button', { name: 'Till' });
    expect(till).toHaveAttribute('aria-pressed', 'false');
    await user.click(till);
    expect(till).toHaveAttribute('aria-pressed', 'true');
    expect(ticked(scopes).sort()).toEqual([
      'scope-passes-read',
      'scope-scans-read',
      'scope-scans-write',
    ]);
    await user.click(within(scopes).getByRole('checkbox', { name: 'Read templates' }));
    expect(till).toHaveAttribute('aria-pressed', 'false');
    expect(within(scopes).getByRole('button', { name: 'Full access' })).toBeInTheDocument();
  });

  it('never tick a credential scope, even from Full access', async () => {
    const { user, scopes } = await openDialog();
    await user.click(within(scopes).getByRole('button', { name: 'Full access' }));
    const on = ticked(scopes);
    expect(on).not.toContain('scope-scanning-admin');
    expect(on).not.toContain('scope-nfc-keys');
    expect(on).not.toContain('scope-api-keys-write');
  });

  it('hide presets a member cannot hold, and the terminal one for a personal key', async () => {
    const { scopes } = await openDialog({
      roles: ['integration_admin'],
      capabilities: ['org:read', 'integrations:read', 'integrations:manage', 'templates:read'],
    });
    const names = within(scopes)
      .getAllByRole('button')
      .map((b) => b.textContent);
    expect(names).toEqual(['Webhooks', 'Integrations']);
  });

  it('hide the till once the key is personal', async () => {
    const { user, dialog, scopes } = await openDialog();
    expect(within(scopes).getByRole('button', { name: 'Till' })).toBeInTheDocument();
    await user.click(within(dialog).getByRole('combobox', { name: 'Type' }));
    await user.click(await screen.findByRole('option', { name: /Personal/ }));
    expect(within(scopes).queryByRole('button', { name: 'Till' })).toBeNull();
  });
});
