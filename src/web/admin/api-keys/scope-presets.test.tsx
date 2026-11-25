import { act, renderHook, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { resetModeForTests, setMode } from '@/web/lib/mode.ts';
import { json, membershipFixture, renderApp } from '@/web/lib/test-utils.tsx';
import { useKeyScopes } from './use-key-scopes.ts';
import { next } from './wizard-test-utils.ts';

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
  await user.type(within(dialog).getByLabelText(/Name/), 'Mine');
  await next(user, dialog);
  await within(dialog).findByRole('heading', { name: 'What it can do' });
  return { user, dialog };
}

const scopesOf = (dialog: HTMLElement) => within(dialog).getByRole('group', { name: /Scopes/ });
const ticked = (scopes: HTMLElement) =>
  within(scopes)
    .getAllByRole('checkbox')
    .filter((c) => c.getAttribute('aria-checked') === 'true' || (c as HTMLInputElement).checked)
    .map((c) => c.id);
const tile = (dialog: HTMLElement, name: RegExp) => within(dialog).queryByRole('radio', { name });

async function usePersonal(user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement) {
  const rail = within(dialog).getByRole('navigation', { name: 'Steps' });
  await user.click(within(rail).getByRole('button', { name: /Basics/ }));
  await user.click(await within(dialog).findByRole('radio', { name: /Personal/ }));
  await next(user, dialog);
}

describe('scope presets', () => {
  it('tick the preset scopes, show them as cards and open the list on Custom', async () => {
    const { user, dialog } = await openDialog();
    expect(within(dialog).getByText('Assign holders, send messages.')).toBeInTheDocument();
    await user.click(tile(dialog, /^Till/) as HTMLElement);
    expect(tile(dialog, /^Till/)).toBeChecked();
    expect(within(dialog).queryByRole('group', { name: /Scopes/ })).toBeNull();
    await user.click(tile(dialog, /^Custom/) as HTMLElement);
    const scopes = scopesOf(dialog);
    expect(ticked(scopes).sort()).toEqual([
      'scope-passes-read',
      'scope-scans-read',
      'scope-scans-write',
    ]);
    await user.click(within(scopes).getByRole('checkbox', { name: 'Read templates' }));
    expect(tile(dialog, /^Till/)).not.toBeChecked();
    expect(tile(dialog, /^Custom/)).toBeChecked();
  });

  it('filters the list by label or scope id', async () => {
    const { user, dialog } = await openDialog();
    const scopes = scopesOf(dialog);
    await user.type(within(scopes).getByRole('searchbox', { name: 'Filter scopes' }), 'webhook');
    expect(
      within(scopes)
        .getAllByRole('checkbox')
        .map((c) => c.id),
    ).toEqual(['scope-webhooks-manage']);
    await user.clear(within(scopes).getByRole('searchbox', { name: 'Filter scopes' }));
    await user.type(within(scopes).getByRole('searchbox', { name: 'Filter scopes' }), 'zzz');
    expect(within(scopes).getByText('No scopes match.')).toBeInTheDocument();
  });

  it('never tick a credential scope, even from Full access', async () => {
    const { user, dialog } = await openDialog();
    await user.click(tile(dialog, /^Full access/) as HTMLElement);
    await user.click(tile(dialog, /^Custom/) as HTMLElement);
    const on = ticked(scopesOf(dialog));
    expect(on).not.toContain('scope-scanning-admin');
    expect(on).not.toContain('scope-nfc-keys');
    expect(on).not.toContain('scope-api-keys-write');
  });

  it('hide presets a member cannot hold', async () => {
    const { dialog } = await openDialog({
      roles: ['integration_admin'],
      capabilities: ['org:read', 'integrations:read', 'integrations:manage', 'templates:read'],
    });
    const names = within(dialog)
      .getAllByRole('radio')
      .map((r) => r.closest('label')?.textContent ?? '');
    expect(names.some((n) => n.startsWith('Webhooks'))).toBe(true);
    expect(names.some((n) => n.startsWith('Integrations'))).toBe(true);
    expect(names.some((n) => n.startsWith('Till'))).toBe(false);
    expect(names.some((n) => n.startsWith('Issue passes'))).toBe(false);
  });

  it('hide the till once the key is personal', async () => {
    const { user, dialog } = await openDialog();
    expect(tile(dialog, /^Till/)).toBeInTheDocument();
    await usePersonal(user, dialog);
    expect(tile(dialog, /^Till/)).toBeNull();
  });

  it('untick what a personal key cannot hold, say so, and re-evaluate the selected preset', async () => {
    const { user, dialog } = await openDialog();
    await user.click(tile(dialog, /^Till/) as HTMLElement);
    await user.click(tile(dialog, /^Issue passes/) as HTMLElement);
    await user.click(tile(dialog, /^Till/) as HTMLElement);
    await user.click(tile(dialog, /^Custom/) as HTMLElement);
    expect(ticked(scopesOf(dialog))).toContain('scope-scans-write');
    await usePersonal(user, dialog);
    const scopes = scopesOf(dialog);
    expect(ticked(scopes).sort()).toEqual(['scope-passes-read', 'scope-scans-read']);
    expect(within(scopes).getByRole('status')).toHaveTextContent('Removed: Scan as a terminal.');
    expect(within(scopes).queryByRole('checkbox', { name: 'Scan as a terminal' })).toBeNull();
    await user.click(within(scopes).getByRole('checkbox', { name: 'Read templates' }));
    expect(within(scopes).queryByRole('status')).toBeNull();
  });

  it('hide review and release in Live and show them in Test', async () => {
    resetModeForTests();
    const live = await openDialog();
    expect(tile(live.dialog, /^Release templates/)).toBeNull();
    expect(within(live.dialog).queryByRole('checkbox', { name: /Approve templates/ })).toBeNull();
    expect(tile(live.dialog, /^Audit/)).toBeInTheDocument();
  });

  it('offer review, release and no audit log in Test', async () => {
    setMode('test');
    const test = await openDialog();
    expect(tile(test.dialog, /^Release templates/)).toBeInTheDocument();
    expect(
      within(test.dialog).getByRole('checkbox', { name: /Approve templates/ }),
    ).toBeInTheDocument();
    expect(tile(test.dialog, /^Audit/)).toBeNull();
    resetModeForTests();
  });
});

describe('changing the mode of a key', () => {
  it('unticks what Live cannot hold and says so', () => {
    const { result } = renderHook(() => useKeyScopes(['passes:read'], 'o1', null));
    act(() => result.current.set(['passes:read', 'templates:review', 'templates:publish']));
    act(() => result.current.reconcile('service', 'live'));
    expect(result.current.scopes).toEqual(['passes:read']);
    expect(result.current.note).toBe(
      'Removed: Approve templates (Test keys), Release templates (Test keys).',
    );
    act(() => result.current.reconcile('service', 'test'));
    expect(result.current.note).toBeUndefined();
  });

  it('unticks the audit log when the key becomes a Test key', () => {
    const { result } = renderHook(() => useKeyScopes(['audit:read'], 'o1', null));
    act(() => result.current.reconcile('service', 'test'));
    expect(result.current.scopes).toEqual([]);
  });

  it('keeps the audit log in Test for a developer sandbox', () => {
    const { result } = renderHook(() => useKeyScopes(['audit:read'], 'o1', null, true));
    act(() => result.current.reconcile('service', 'test'));
    expect(result.current.scopes).toEqual(['audit:read']);
    expect(result.current.note).toBeUndefined();
  });
});
