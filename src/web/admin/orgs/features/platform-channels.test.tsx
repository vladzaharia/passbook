import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { OrgEntitlementsDto } from '@/shared/contracts/entitlement-admin.ts';
import { ENTITLEMENT_KEYS, presetValues } from '@/shared/contracts/entitlements.ts';
import type { PassSetup } from '@/shared/contracts/pass-setup.ts';
import {
  channelOf,
  enrolmentOf,
  identityOf,
  readyFacts,
  viewOf,
} from '@/shared/pass-setup-test-fixtures.ts';
import { json, renderApp } from '@/web/lib/test-utils.tsx';

const base = presetValues('standard');
const features: OrgEntitlementsDto = {
  orgId: 'o1',
  preset: 'standard',
  presetLabel: 'Standard',
  revision: 3,
  updatedAt: 1_700_000_000_000,
  items: ENTITLEMENT_KEYS.map((key) => ({
    key,
    value: base[key],
    presetValue: base[key],
    source: 'preset' as const,
    note: null,
    expiresAt: null,
  })),
  presets: [{ preset: 'standard', label: 'Standard', orgCount: 1, values: base }],
};
const org = {
  id: 'o1',
  slug: 'acme',
  name: 'Acme Fitness',
  status: 'active',
  createdAt: 1_700_000_000_000,
  counts: { passes: 12, templates: 2, connections: 1, apiKeys: 3 },
  countsCapped: false,
};
const managedIdentity = {
  id: 'idn_1',
  orgId: 'o1',
  label: 'Acme Fitness',
  passTypeIdentifier: 'pass.mobile.passbook.acmefitness',
  teamIdentifier: 'TEAM123',
  source: 'db',
  certSha256: 'ab12',
  certSubject: null,
  certSerial: null,
  notBefore: 1_600_000_000_000,
  notAfter: Date.now() + 200 * 86_400_000,
  daysRemaining: 200,
  apnsBinding: null,
  apnsAvailable: true,
  pushMethod: 'key',
  pushKey: null,
  apnsHealth: 'healthy',
  nfcEnabled: false,
  isDefault: false,
  createdAt: 1_600_000_000_000,
  kind: 'managed',
  status: 'active',
  rotation: 'auto',
  issuing: true,
  nextRotationAt: null,
  handle: 'acmefitness',
};

/** Paper is not in the plan; Google is released with an account the platform can hold. */
function view(held = false): PassSetup {
  const v = viewOf(readyFacts());
  const account = enrolmentOf('google', {
    state: held ? 'held' : 'on',
    accountId: 'acc1',
    source: 'platform',
    platformAvailable: true,
    issuance: { state: 'enabled' },
    hold: held ? { at: 1, reason: 'Abuse report' } : null,
  });
  return {
    ...v,
    orgId: 'o1',
    apple: { ...v.apple, identity: identityOf({ orgId: 'o1', id: 'idn_1' }) },
    channels: { ...v.channels, google: channelOf(undefined, { account }) },
  };
}

function open(setup: PassSetup, calls: { path: string; body: unknown }[] = []) {
  const post = (path: string) => (_url: URL, init?: RequestInit) => {
    calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null });
    return json({ status: 'held' });
  };
  return renderApp('/admin/platform/orgs/o1?tab=features', {
    session: 'admin',
    handlers: {
      '/api/v1/orgs/o1': () => json(org),
      '/api/v1/platform/orgs/o1/entitlements': () => json(features),
      '/api/v1/orgs/o1/pass-setup': () => json(setup),
      '/api/v1/identities/idn_1': () => json(managedIdentity),
      '/api/v1/identities/idn_1/renew': post('renew'),
      '/api/v1/platform/orgs/o1/wallet-enrolments/live/google/hold': post('hold'),
      '/api/v1/platform/orgs/o1/wallet-enrolments/live/google/release': post('release'),
    },
  });
}

const row = async (channel: string) =>
  await waitFor(() => {
    const el = document.querySelector<HTMLElement>(`[data-channel="${channel}"]`);
    if (!el) throw new Error('No row yet');
    return el;
  });

describe('Platform org Features: channels and Apple ID', () => {
  it('draws the chain per channel, with Include on a channel the plan lacks', async () => {
    const user = userEvent.setup();
    await open(view());
    const paper = await row('paper');
    expect(within(paper).getByText('Not in your plan')).toBeInTheDocument();
    expect(within(paper).getByRole('list', { name: 'Chain' })).toBeInTheDocument();
    await user.click(within(paper).getByRole('button', { name: 'Include' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('says a stopped wallet is not released, and nothing on a released one', async () => {
    await open(view());
    const samsung = await row('samsung');
    expect(within(samsung).getByText("Samsung Wallet isn't released yet.")).toBeInTheDocument();
    expect(within(await row('google')).queryByText(/released yet/)).toBeNull();
  });

  it('holds a released wallet with a reason, and releases a held one', async () => {
    const user = userEvent.setup();
    const calls: { path: string; body: unknown }[] = [];
    await open(view(), calls);
    const google = await row('google');
    await user.click(within(google).getByRole('button', { name: 'Hold' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/Reason/), 'Abuse report');
    await user.click(within(dialog).getByRole('button', { name: 'Hold' }));
    await waitFor(() =>
      expect(calls).toEqual([{ path: 'hold', body: { reason: 'Abuse report' } }]),
    );
  });

  it('shows Release on a held wallet', async () => {
    const user = userEvent.setup();
    const calls: { path: string; body: unknown }[] = [];
    await open(view(true), calls);
    const google = await row('google');
    expect(within(google).getByText('Held')).toBeInTheDocument();
    await user.click(within(google).getByRole('button', { name: 'Release' }));
    await waitFor(() => expect(calls.map((c) => c.path)).toEqual(['release']));
  });

  it('shows the Apple ID with Renew now and its certificates', async () => {
    const user = userEvent.setup();
    const calls: { path: string; body: unknown }[] = [];
    await open(view(), calls);
    expect(await screen.findByText('pass.mobile.passbook.acmefitness')).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Renew now' }));
    await waitFor(() => expect(calls.map((c) => c.path)).toEqual(['renew']));
    await user.click(screen.getAllByRole('button', { name: 'More' }).at(-1) as HTMLElement);
    expect(await screen.findByRole('menuitem', { name: 'Pause auto-renew' })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: 'Stop new passes' })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: 'Certificates' })).toBeVisible();
  });
});
