import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { OrgEntitlementsDto } from '@/shared/contracts/entitlement-admin.ts';
import type { EntitlementPresetDto } from '@/shared/contracts/entitlement-presets.ts';
import {
  ENTITLEMENT_KEYS,
  ENTITLEMENT_PRESETS,
  presetValues,
} from '@/shared/contracts/entitlements.ts';
import { json, problem, renderApp } from '@/web/lib/test-utils.tsx';

const ORG = '/api/v1/platform/orgs/o1/entitlements';
const PRESETS = '/api/v1/platform/entitlement-presets';

const org: OrgEntitlementsDto = {
  orgId: 'o1',
  preset: 'trial',
  presetLabel: 'Trial',
  revision: 3,
  updatedAt: 1_700_000_000_000,
  items: ENTITLEMENT_KEYS.map((key) => ({
    key,
    value: presetValues('trial')[key],
    presetValue: presetValues('trial')[key],
    source: 'preset' as const,
    note: null,
    expiresAt: null,
  })),
  presets: ENTITLEMENT_PRESETS.filter((p) => p !== 'developer').map((p) => ({
    preset: p,
    label: p,
    orgCount: 1,
    values: presetValues(p),
  })),
};

const preset = (over: Partial<EntitlementPresetDto> = {}): EntitlementPresetDto => ({
  preset: 'trial',
  label: 'Trial',
  revision: 4,
  updatedAt: 1_700_000_000_000,
  orgCount: 2,
  pendingOrgs: 0,
  values: presetValues('trial'),
  ...over,
});

function open(
  presets: EntitlementPresetDto[],
  puts: unknown[],
  conflict = false,
  reply?: (n: number) => { moved: number; pendingOrgs: number },
) {
  return renderApp('/admin/platform/orgs/o1?tab=features', {
    session: 'admin',
    handlers: {
      '/api/v1/orgs/o1': () =>
        json({
          id: 'o1',
          slug: 'acme',
          name: 'Acme Gym',
          status: 'active',
          createdAt: 1_700_000_000_000,
          counts: { passes: 1, templates: 1, connections: 0, apiKeys: 0 },
          countsCapped: false,
        }),
      [ORG]: () => json(org),
      [PRESETS]: (_url, init) => {
        if (init?.method !== 'PUT') return json({ presets });
        puts.push(JSON.parse(String(init.body)));
        if (conflict) return problem(409, 'ENTITLEMENTS_CHANGED', 'The preset changed. Reload.');
        const r = reply?.(puts.length) ?? { moved: 2, pendingOrgs: 0 };
        return json({
          preset: preset({ revision: 5, pendingOrgs: r.pendingOrgs }),
          moved: r.moved,
        });
      },
    },
  });
}

describe('Edit presets', () => {
  it('changes one value after showing who it moves and what it does', async () => {
    const user = userEvent.setup();
    const puts: unknown[] = [];
    await open([preset()], puts);
    await user.click(await screen.findByRole('button', { name: 'Edit presets' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit presets' });
    await user.click(await within(dialog).findByRole('combobox', { name: /Feature/ }));
    await user.click(await screen.findByRole('option', { name: /Webhooks: Off/ }));
    await user.click(within(dialog).getByRole('radio', { name: 'On' }));
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(within(confirm).getByRole('heading', { name: 'Change Trial?' })).toBeVisible();
    expect(within(confirm).getByText(/Moves 2 organizations\./)).toBeVisible();
    expect(within(confirm).getByText(/1 turns on/)).toBeVisible();
    expect(puts).toHaveLength(0);
    await user.click(within(confirm).getByRole('button', { name: 'Change' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({ preset: 'trial', expectedRevision: 4, values: { webhooks: 1 } });
  });

  it('says Close until a value is changed, then Cancel', async () => {
    const user = userEvent.setup();
    await open([preset()], []);
    await user.click(await screen.findByRole('button', { name: 'Edit presets' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit presets' });
    expect(await within(dialog).findByRole('button', { name: 'Continue' })).toBeVisible();
    expect(within(dialog).queryByRole('button', { name: 'Cancel' })).toBeNull();
    await user.click(within(dialog).getByRole('combobox', { name: /Feature/ }));
    await user.click(await screen.findByRole('option', { name: /Webhooks: Off/ }));
    await user.click(within(dialog).getByRole('radio', { name: 'On' }));
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeVisible();
  });

  it('offers to move the organizations an earlier change has not reached, with no values', async () => {
    const user = userEvent.setup();
    const puts: unknown[] = [];
    await open([preset({ pendingOrgs: 3 })], puts);
    await user.click(await screen.findByRole('button', { name: 'Edit presets' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit presets' });
    expect(await within(dialog).findByText('3 organizations not moved yet')).toBeVisible();
    expect(within(dialog).queryByRole('button', { name: 'Continue' })).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Move the rest' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({ preset: 'trial', expectedRevision: 4, values: {} });
  });

  it('keeps calling with no values until none wait, and reports the sum', async () => {
    const user = userEvent.setup();
    const puts: unknown[] = [];
    const steps = [
      { moved: 50, pendingOrgs: 80 },
      { moved: 50, pendingOrgs: 30 },
      { moved: 30, pendingOrgs: 0 },
    ];
    await open([preset({ pendingOrgs: 130 })], puts, false, (n) => steps[n - 1] ?? steps[2]!);
    await user.click(await screen.findByRole('button', { name: 'Edit presets' }));
    await user.click(await screen.findByRole('button', { name: 'Move the rest' }));
    await waitFor(() => expect(puts).toHaveLength(3));
    expect(puts[1]).toEqual({ preset: 'trial', expectedRevision: 5, values: {} });
    expect(await screen.findByText('130 organizations moved')).toBeVisible();
  });

  it('stops when a call moves nobody', async () => {
    const user = userEvent.setup();
    const puts: unknown[] = [];
    await open([preset({ pendingOrgs: 5 })], puts, false, () => ({ moved: 0, pendingOrgs: 5 }));
    await user.click(await screen.findByRole('button', { name: 'Edit presets' }));
    await user.click(await screen.findByRole('button', { name: 'Move the rest' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts).toHaveLength(1);
  });
});
