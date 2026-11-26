import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ORG_WEBSITE_INVALID } from '@/shared/copy/org-website.ts';
import { json, membershipFixture, renderApp } from '@/web/lib/test-utils.tsx';
import { localZone, zoneLabel } from '@/web/lib/timezones.ts';
import { planFixture } from '../plan/plan-fixtures.ts';

const org = {
  id: 'o1',
  slug: 'acme',
  name: 'Acme Gym',
  status: 'active',
  defaultIdentityId: null,
  branding: { accent: '#0f766e' },
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  counts: { passes: 12, templates: 2, connections: 1, apiKeys: 3 },
  countsCapped: false,
};

interface Row {
  value: unknown;
  source?: 'org' | 'default';
  default?: unknown;
  ceiling?: number;
  blockedByPlatform?: boolean;
  blockedByPlan?: boolean;
  planBlocked?: string[];
}
const item = (key: string, row: Row) => ({
  scope: 'org:o1',
  key,
  source: 'default',
  updatedAt: row.source === 'org' ? 1_700_000_000_000 : null,
  updatedBy: row.source === 'org' ? 'u1' : null,
  ...row,
});

function setup(
  rows: Record<string, Row>,
  onPut?: (body: unknown) => void,
  page = 'settings',
  extra: { kind?: 'developer'; api?: 'read' | 'full' | null } = {},
) {
  return renderApp(`/admin/o/o1/${page}`, {
    session: 'admin',
    memberships: [membershipFixture('o1')],
    handlers: {
      '/api/v1/orgs/o1': () => json({ ...org, kind: extra.kind }),
      '/api/v1/orgs/o1/workspace': () => json({ ...org, kind: extra.kind }),
      '/api/v1/orgs/o1/plan': () =>
        json(
          planFixture({
            orgId: 'o1',
            features: [{ key: 'api', level: extra.api === undefined ? 'full' : extra.api }],
          }),
        ),
      '/api/v1/wallet-providers/accounts': () => json({ items: [] }),
      '/api/v1/orgs/o1/memberships': () => json({ items: [] }),
      '/api/v1/orgs/o1/invitations': () => json({ items: [] }),
      '/api/v1/identities': () => json({ items: [], nextCursor: null }),
      '/api/v1/orgs/o1/retention/holds': () => json({ items: [] }),
      '/api/v1/orgs/o1/retention/receipts': () => json({ items: [], nextCursor: null }),
      '/api/v1/settings': (_url, init) => {
        if (init?.method === 'PUT') onPut?.(JSON.parse(String(init.body)));
        return json({ items: Object.entries(rows).map(([key, row]) => item(key, row)) });
      },
    },
  });
}

describe('org settings inheritance', () => {
  it('shows an unset value as an empty input with the default as placeholder and hint', async () => {
    await setup(
      { 'retention.scansDays': { value: 396, default: 396, ceiling: 1095 } },
      undefined,
      'retention',
    );
    const input = await screen.findByLabelText('Scans');
    expect(input).toHaveValue(null);
    expect(input).toHaveAttribute('placeholder', '396');
    expect(screen.getByText(/Up to 1095 days · Default/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use default for Scans' })).toBeNull();
  });

  it('shows a set value with a Use default reset that sends null on save', async () => {
    let body: unknown;
    await setup(
      { 'retention.scansDays': { value: 200, source: 'org', default: 396, ceiling: 1095 } },
      (put) => {
        body = put;
      },
      'retention',
    );
    expect(await screen.findByLabelText('Scans')).toHaveValue(200);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Use default for Scans' }));
    expect(screen.getByLabelText('Scans')).toHaveValue(null);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(body).toMatchObject({ scope: 'org:o1', values: { 'retention.scansDays': null } }),
    );
  });

  it('names the platform ceiling on a capped field', async () => {
    await setup({
      'email.orgCapPerDay': { value: 100, source: 'org', default: 100, ceiling: 100 },
    });
    expect(await screen.findByLabelText('Emails per day')).toHaveValue(100);
    expect(screen.getByText('Up to 100')).toBeInTheDocument();
  });

  it('keeps platform-only settings off the organization page', async () => {
    await setup({ 'email.buddy': { value: false, default: false } });
    await screen.findByLabelText('Emails per day').catch(() => undefined);
    expect(screen.queryByLabelText('Refresh cooldown')).toBeNull();
    expect(screen.queryByLabelText('Magic-link sign-in')).toBeNull();
  });

  it('shows created, id and the signing identity with a link to Brand and channels', async () => {
    await renderApp('/admin/o/o1/settings', {
      session: 'admin',
      memberships: [membershipFixture('o1')],
      handlers: {
        '/api/v1/orgs/o1': () => json(org),
        '/api/v1/orgs/o1/workspace': () => json(org),
        '/api/v1/identities': () =>
          json({
            items: [
              {
                id: 'i1',
                label: 'Acme signer',
                passTypeIdentifier: 'pass.acme',
                teamIdentifier: 'T',
                certSubject: null,
                certSerial: null,
                notBefore: null,
                notAfter: Date.UTC(2027, 5, 1),
                daysRemaining: 200,
                apnsAvailable: true,
                apnsHealth: 'healthy',
              },
            ],
            nextCursor: null,
          }),
        '/api/v1/settings': () => json({ items: [] }),
      },
    });
    const link = await screen.findByRole('link', { name: /Acme signer, expires/ });
    expect(link).toHaveAttribute('href', '/admin/o/o1/brand#channels');
    expect(screen.getAllByText('o1').length).toBeGreaterThan(0);
    expect(screen.getByText('Created')).toBeInTheDocument();
  });
});

describe('org time zone', () => {
  it('suggests the browser zone but saves nothing until it is picked and saved', async () => {
    const puts: unknown[] = [];
    await setup(
      { 'org.timeZone': { value: 'America/Los_Angeles', default: 'America/Los_Angeles' } },
      (put) => puts.push(put),
    );
    const user = userEvent.setup();
    const picker = await screen.findByRole('combobox', { name: /Time zone/ });
    expect(picker).toHaveTextContent(`${zoneLabel('America/Los_Angeles')} · default`);
    expect(puts).toEqual([]);
    await user.click(screen.getByRole('button', { name: `Use ${zoneLabel(localZone())}` }));
    expect(screen.queryByRole('button', { name: `Use ${zoneLabel(localZone())}` })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(puts).toEqual([{ scope: 'org:o1', values: { 'org.timeZone': localZone() } }]),
    );
  });

  it('searches the zones, saves the pick and clears it with null', async () => {
    const puts: unknown[] = [];
    await setup({ 'org.timeZone': { value: 'Europe/Paris', source: 'org' } }, (put) =>
      puts.push(put),
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('combobox', { name: /Time zone/ }));
    await user.type(screen.getByPlaceholderText('Search time zones'), 'Berlin');
    await user.click(await screen.findByRole('option', { name: /Berlin/ }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(puts[0]).toEqual({ scope: 'org:o1', values: { 'org.timeZone': 'Europe/Berlin' } }),
    );
    await user.click(screen.getByRole('combobox', { name: /Time zone/ }));
    await user.click(
      await screen.findByRole('option', { name: `${zoneLabel('America/Los_Angeles')} · default` }),
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(puts[1]).toEqual({ scope: 'org:o1', values: { 'org.timeZone': null } }),
    );
  });
});

describe('org website', () => {
  it('refuses an http address with one sentence and saves an https one', async () => {
    const puts: unknown[] = [];
    await setup({ 'org.website': { value: null } }, (put) => puts.push(put));
    const user = userEvent.setup();
    const input = await screen.findByLabelText('Website');
    await user.type(input, 'http://gym.example');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(ORG_WEBSITE_INVALID)).toBeInTheDocument();
    expect(puts).toEqual([]);
    await user.clear(input);
    await user.type(input, 'https://gym.example');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(puts).toEqual([{ scope: 'org:o1', values: { 'org.website': 'https://gym.example' } }]),
    );
  });
});

describe('request log bodies row', () => {
  const label = 'Record request bodies in Test';
  it('is under Privacy for an organization with API access', async () => {
    await setup({ 'requestLog.bodies': { value: false } });
    expect(await screen.findByText(label)).toBeInTheDocument();
  });
  it('is hidden in a sandbox, where bodies are always on', async () => {
    await setup({ 'requestLog.bodies': { value: false } }, undefined, 'settings', {
      kind: 'developer',
    });
    await screen.findByText('Privacy');
    expect(screen.queryByText(label)).not.toBeInTheDocument();
  });
  it('is hidden where the plan has no API access', async () => {
    await setup({ 'requestLog.bodies': { value: false } }, undefined, 'settings', { api: null });
    await screen.findByText('Privacy');
    await waitFor(() => expect(screen.queryByText(label)).not.toBeInTheDocument());
  });
});
