import { act, renderHook, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { resetModeForTests, setMode } from '@/web/lib/mode.ts';
import { json, membershipFixture, renderApp } from '@/web/lib/test-utils.tsx';
import { useKeyScopes } from './use-key-scopes.ts';

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
      .getAllByRole('button', { name: /^(?!Preset scopes)/ })
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

  it('untick what a personal key cannot hold, say so, and re-evaluate the selected preset', async () => {
    const { user, dialog, scopes } = await openDialog();
    const till = within(scopes).getByRole('button', { name: 'Till' });
    await user.click(till);
    await user.click(within(scopes).getByRole('button', { name: 'Issue passes' }));
    await user.click(till);
    expect(ticked(scopes)).toContain('scope-scans-write');
    await user.click(within(dialog).getByRole('combobox', { name: 'Type' }));
    await user.click(await screen.findByRole('option', { name: /Personal/ }));
    expect(ticked(scopes).sort()).toEqual(['scope-passes-read', 'scope-scans-read']);
    expect(within(scopes).getByRole('status')).toHaveTextContent('Removed: Scan as a terminal.');
    expect(within(scopes).queryByRole('checkbox', { name: 'Scan as a terminal' })).toBeNull();
    await user.click(within(scopes).getByRole('checkbox', { name: 'Read templates' }));
    expect(within(scopes).queryByRole('status')).toBeNull();
  });

  it('lists every preset scope in a popover opened by tap', async () => {
    const { user, scopes } = await openDialog();
    await user.click(within(scopes).getByRole('button', { name: 'Preset scopes' }));
    const term = (await screen.findAllByText('Holder support')).find((e) => e.tagName === 'DT');
    expect(term?.closest('div')).toHaveTextContent('passes:read, holders:write, messages:write');
    expect(screen.getAllByText('Template authoring').some((e) => e.tagName === 'DT')).toBe(true);
  });

  it('hide review and release in Live and show them in Test', async () => {
    resetModeForTests();
    const live = await openDialog();
    expect(within(live.scopes).queryByRole('button', { name: 'Release templates' })).toBeNull();
    expect(within(live.scopes).queryByRole('checkbox', { name: /Approve templates/ })).toBeNull();
    expect(within(live.scopes).getByRole('button', { name: 'Audit' })).toBeInTheDocument();
  });

  it('offer review, release and no audit log in Test', async () => {
    setMode('test');
    const test = await openDialog();
    expect(
      within(test.scopes).getByRole('button', { name: 'Release templates' }),
    ).toBeInTheDocument();
    expect(
      within(test.scopes).getByRole('checkbox', { name: /Approve templates/ }),
    ).toBeInTheDocument();
    expect(within(test.scopes).queryByRole('button', { name: 'Audit' })).toBeNull();
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
