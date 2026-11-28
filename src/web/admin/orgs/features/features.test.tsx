import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { OrgEntitlementsDto } from '@/shared/contracts/entitlement-admin.ts';
import {
  ENTITLEMENT_KEYS,
  ENTITLEMENT_PRESETS,
  type EntitlementKey,
  type EntitlementPreset,
  type EntitlementValue,
  presetValues,
} from '@/shared/contracts/entitlements.ts';
import { PRESET_LABEL } from '@/shared/copy/entitlements.ts';
import { json, problem, renderApp } from '@/web/lib/test-utils.tsx';

const PATH = '/api/v1/platform/orgs/o1/entitlements';
const LABEL = PRESET_LABEL;
const COUNTS = {
  legacy: 4,
  trial: 1,
  starter: 2,
  standard: 7,
  business: 2,
  premium: 3,
  enterprise: 1,
  developer: 0,
} as const;

type Override = { value: EntitlementValue; note?: string | null; expiresAt?: number | null };

function state(
  preset: EntitlementPreset = 'legacy',
  overrides: Partial<Record<EntitlementKey, Override>> = {},
  revision = 3,
): OrgEntitlementsDto {
  const base = presetValues(preset);
  return {
    orgId: 'o1',
    preset,
    presetLabel: LABEL[preset],
    revision,
    updatedAt: 1_700_000_000_000,
    items: ENTITLEMENT_KEYS.map((key) => {
      const o = overrides[key];
      return {
        key,
        value: o ? o.value : base[key],
        presetValue: base[key],
        source: o ? 'override' : 'preset',
        note: o?.note ?? null,
        expiresAt: o?.expiresAt ?? null,
      };
    }),
    // The developer preset belongs to developer orgs only; the server lists it for them alone.
    presets: ENTITLEMENT_PRESETS.filter((p) => p !== 'developer').map((p) => ({
      preset: p,
      label: LABEL[p],
      orgCount: COUNTS[p],
      values: presetValues(p),
    })),
  };
}

const org = {
  id: 'o1',
  slug: 'acme',
  name: 'Acme Gym',
  status: 'active',
  createdAt: 1_700_000_000_000,
  counts: { passes: 12, templates: 2, connections: 1, apiKeys: 3 },
  countsCapped: false,
};

interface Server {
  current: OrgEntitlementsDto;
  puts: Record<string, unknown>[];
  conflict?: boolean;
}

function open(server: Server) {
  return renderApp('/admin/platform/orgs/o1?tab=features', {
    session: 'admin',
    handlers: {
      '/api/v1/orgs/o1': () => json(org),
      [PATH]: (_url, init) => {
        if (init?.method !== 'PUT') return json(server.current);
        server.puts.push(JSON.parse(String(init.body)));
        if (server.conflict)
          return problem(409, 'ENTITLEMENTS_CHANGED', 'The features changed. Reload and retry.');
        const body = server.puts.at(-1) as {
          preset: EntitlementPreset;
          overrides: Partial<Record<EntitlementKey, Override>>;
        };
        server.current = state(body.preset, body.overrides, server.current.revision + 1);
        return json(server.current);
      },
    },
  });
}

describe('Features tab', () => {
  it('shows the preset, the features by section and where each value comes from', async () => {
    const server: Server = {
      current: state('trial', {
        print: { value: 1, note: 'Pilot with Northwind', expiresAt: 4_000_000_000_000 },
      }),
      puts: [],
    };
    await open(server);
    expect(await screen.findByRole('heading', { name: 'Plan', level: 2 })).toBeVisible();
    expect(screen.getByRole('radio', { name: /Stub/ })).toBeChecked();
    expect(screen.getByText('Current')).toBeVisible();
    for (const group of ['API', 'Integrations', 'Wallets and delivery'])
      expect(screen.getByRole('heading', { name: group, level: 2 })).toBeVisible();
    const row = screen
      .getByRole('list', { name: 'Wallets and delivery' })
      .querySelector('[data-row-id="print"]');
    expect(row).not.toBeNull();
    const line = within(row as HTMLElement);
    expect(line.getByText('Override')).toBeVisible();
    expect(line.getByText(/Stub: Off · Pilot with Northwind · Until /)).toBeVisible();
    expect(line.getByText('On')).toBeVisible();
    expect(screen.getByRole('tab', { name: 'Features', selected: true })).toBeVisible();
  });

  it('shows what a preset changes before anything is saved, then asks and saves with the revision', async () => {
    const user = userEvent.setup();
    const server: Server = { current: state('legacy'), puts: [] };
    await open(server);
    await user.click(await screen.findByRole('radio', { name: /Stub/ }));
    const callout = screen.getAllByText('Stub instead of Unlimited')[0] as HTMLElement;
    expect(screen.getByRole('list', { name: 'Impact' })).toBeVisible();
    expect(
      within(screen.getByRole('list', { name: 'Impact' })).getByText(/turn off/),
    ).toBeVisible();
    expect(callout).toBeVisible();
    expect(server.puts).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Apply Stub' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByRole('heading', { name: 'Apply Stub to Acme Gym?' })).toBeVisible();
    expect(within(dialog).getByText(/turn off/)).toBeVisible();
    expect(within(dialog).getByText(/Nothing is deleted\./)).toBeVisible();
    expect(server.puts).toHaveLength(0);

    await user.click(within(dialog).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(server.puts).toHaveLength(1));
    expect(server.puts[0]).toEqual({ expectedRevision: 3, preset: 'trial', overrides: {} });
    expect(await screen.findByRole('radio', { name: /Stub/, checked: true })).toBeVisible();
    expect(screen.queryAllByText('Stub instead of Unlimited')).toHaveLength(0);
  });

  it('cancels a pick without saving, and keeps overrides on the way through', async () => {
    const user = userEvent.setup();
    const server: Server = {
      current: state('legacy', { 'api.keys': { value: 5, note: null } }),
      puts: [],
    };
    await open(server);
    await user.click(await screen.findByRole('radio', { name: /Season Pass/ }));
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.queryAllByText('Season Pass instead of Unlimited')).toHaveLength(0);
    expect(screen.getByRole('radio', { name: 'Unlimited' })).toBeChecked();

    await user.click(screen.getByRole('radio', { name: /Season Pass/ }));
    await user.click(screen.getByRole('button', { name: 'Apply Season Pass' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Apply' }),
    );
    await waitFor(() => expect(server.puts).toHaveLength(1));
    expect(server.puts[0]).toMatchObject({
      preset: 'standard',
      overrides: { 'api.keys': { value: 5, note: null, expiresAt: null } },
    });
  });

  it('overrides one feature with a note, shows the impact and saves after the confirm', async () => {
    const user = userEvent.setup();
    const server: Server = { current: state('trial'), puts: [] };
    await open(server);
    await user.click(await screen.findByRole('button', { name: 'Override Print at home' }));
    const form = await screen.findByRole('dialog', { name: 'Override Print at home' });
    await user.click(within(form).getByRole('radio', { name: 'On' }));
    await user.type(within(form).getByLabelText('Note'), 'Pilot with Northwind');
    await user.click(within(form).getByRole('button', { name: 'Continue' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(within(confirm).getByRole('heading', { name: 'Override Print at home?' })).toBeVisible();
    expect(within(confirm).getByText('Changes 1 feature: 1 turns on.')).toBeVisible();
    expect(server.puts).toHaveLength(0);
    await user.click(within(confirm).getByRole('button', { name: 'Override' }));
    await waitFor(() => expect(server.puts).toHaveLength(1));
    expect(server.puts[0]).toEqual({
      expectedRevision: 3,
      preset: 'trial',
      overrides: { print: { value: 1, note: 'Pilot with Northwind', expiresAt: null } },
    });
    expect(await screen.findByText('Override')).toBeVisible();
  });

  it('sets a limit, and refuses one that is not a number', async () => {
    const user = userEvent.setup();
    const server: Server = { current: state('standard'), puts: [] };
    await open(server);
    await user.click(await screen.findByRole('button', { name: 'Override Members' }));
    const form = await screen.findByRole('dialog', { name: 'Override Members' });
    const field = within(form).getByLabelText('Limit');
    await user.clear(field);
    await user.click(within(form).getByRole('button', { name: 'Continue' }));
    expect(await within(form).findByText('Enter a whole number, 0 or more.')).toBeVisible();
    await user.type(field, '2');
    await user.click(within(form).getByRole('button', { name: 'Continue' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(within(confirm).getByText(/1 lowered/)).toBeVisible();
    await user.click(within(confirm).getByRole('button', { name: 'Override' }));
    await waitFor(() => expect(server.puts).toHaveLength(1));
    expect(server.puts[0]).toMatchObject({ overrides: { members: { value: 2 } } });
  });

  it('resets an override after a confirm and sends the rest unchanged', async () => {
    const user = userEvent.setup();
    const server: Server = {
      current: state('trial', {
        print: { value: 1 },
        'api.keys': { value: 5 },
      }),
      puts: [],
    };
    await open(server);
    await user.click(await screen.findByRole('button', { name: 'Reset Print at home to Stub' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(
      within(confirm).getByRole('heading', { name: 'Reset Print at home to Stub?' }),
    ).toBeVisible();
    expect(within(confirm).getByText(/1 turns off/)).toBeVisible();
    await user.click(within(confirm).getByRole('button', { name: 'Reset' }));
    await waitFor(() => expect(server.puts).toHaveLength(1));
    expect(server.puts[0]).toEqual({
      expectedRevision: 3,
      preset: 'trial',
      overrides: { 'api.keys': { value: 5, note: null, expiresAt: null } },
    });
  });

  it('says so when another save landed first, and reloads the state', async () => {
    const user = userEvent.setup();
    const server: Server = { current: state('legacy'), puts: [], conflict: true };
    await open(server);
    await user.click(await screen.findByRole('radio', { name: /Stub/ }));
    await user.click(screen.getByRole('button', { name: 'Apply Stub' }));
    const confirm = await screen.findByRole('alertdialog');
    server.current = state('standard', {}, 4);
    await user.click(within(confirm).getByRole('button', { name: 'Apply' }));
    expect(
      await within(confirm).findByText('The features changed. Reload and retry.'),
    ).toBeVisible();
    // The tab reloaded behind the dialog: Season Pass is stored now, and the pick is measured against it.
    expect((await screen.findAllByText('Stub instead of Season Pass'))[0]).toBeVisible();
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('Current').closest('[data-plan-tile]')).toHaveTextContent(
      'Season Pass',
    );
  });

  it('shows an error with Retry when the features cannot be read', async () => {
    await renderApp('/admin/platform/orgs/o1?tab=features', {
      session: 'admin',
      handlers: {
        '/api/v1/orgs/o1': () => json(org),
        [PATH]: () => problem(500, 'INTERNAL', 'Failed.'),
      },
    });
    expect(await screen.findByRole('button', { name: /Retry|Try again/ })).toBeVisible();
  });
});

describe('Features tab without a row', () => {
  it('says no features are set and offers one Apply plan action that creates the row', async () => {
    const user = userEvent.setup();
    const empty: OrgEntitlementsDto = {
      ...state('legacy'),
      preset: null,
      presetLabel: null,
      revision: 0,
      updatedAt: null,
      items: [],
    };
    const server: Server = { current: empty, puts: [] };
    await open(server);
    expect(await screen.findByText('No features set')).toBeVisible();
    const apply = screen.getByRole('button', { name: 'Apply plan' });
    expect(apply).toBeDisabled();
    expect(screen.queryByRole('list', { name: 'API' })).toBeNull();
    await user.click(screen.getByRole('radio', { name: /Season Pass/ }));
    await user.click(apply);
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Sets its features for the first time.')).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(server.puts).toHaveLength(1));
    expect(server.puts[0]).toEqual({ expectedRevision: 0, preset: 'standard', overrides: {} });
    expect(await screen.findByRole('radio', { name: /Season Pass/, checked: true })).toBeVisible();
  });
});
