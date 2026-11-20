import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { json, membershipFixture, renderApp } from '@/web/lib/test-utils.tsx';

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
}
const item = (key: string, row: Row) => ({
  scope: 'org:o1',
  key,
  source: 'default',
  updatedAt: row.source === 'org' ? 1_700_000_000_000 : null,
  updatedBy: row.source === 'org' ? 'u1' : null,
  ...row,
});

function setup(rows: Record<string, Row>, onPut?: (body: unknown) => void) {
  return renderApp('/admin/o/o1/settings', {
    session: 'admin',
    memberships: [membershipFixture('o1')],
    handlers: {
      '/api/v1/orgs/o1': () => json(org),
      '/api/v1/orgs/o1/workspace': () => json(org),
      '/api/v1/wallet-providers/accounts': () => json({ items: [] }),
      '/api/v1/orgs/o1/memberships': () => json({ items: [] }),
      '/api/v1/orgs/o1/invitations': () => json({ items: [] }),
      '/api/v1/identities': () => json({ items: [], nextCursor: null }),
      '/api/v1/settings': (_url, init) => {
        if (init?.method === 'PUT') onPut?.(JSON.parse(String(init.body)));
        return json({ items: Object.entries(rows).map(([key, row]) => item(key, row)) });
      },
    },
  });
}

describe('org settings inheritance', () => {
  it('shows an unset value as an empty input with the default as placeholder and hint', async () => {
    await setup({ 'retention.scansDays': { value: 396, default: 396, ceiling: 1095 } });
    const input = await screen.findByLabelText('Scans');
    expect(input).toHaveValue(null);
    expect(input).toHaveAttribute('placeholder', '396');
    expect(screen.getByText('Up to 1095 days · Default')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use default for Scans' })).toBeNull();
  });

  it('shows a set value with a Use default reset that sends null on save', async () => {
    let body: unknown;
    await setup(
      { 'retention.scansDays': { value: 200, source: 'org', default: 396, ceiling: 1095 } },
      (put) => {
        body = put;
      },
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

  it('disables the NFC tag switch while the platform switch is off', async () => {
    await setup({
      'nfc.tags': {
        value: { enabled: false },
        default: { enabled: false },
        blockedByPlatform: true,
      },
    });
    const toggle = await screen.findByRole('switch', { name: 'Linked NFC allowed' });
    expect(toggle).toBeDisabled();
    expect(screen.getByText('Not released yet')).toBeInTheDocument();
  });

  it('leaves the NFC tag switch usable when the platform switch is on', async () => {
    await setup({ 'nfc.tags': { value: { enabled: false }, default: { enabled: false } } });
    expect(await screen.findByRole('switch', { name: 'Linked NFC allowed' })).toBeEnabled();
    expect(screen.getByText('Off for this organization')).toBeInTheDocument();
  });

  it('blocks a channel for the organization and turns NFC tags on', async () => {
    const bodies: unknown[] = [];
    await setup(
      {
        'nfc.tags': { value: { enabled: false }, default: { enabled: false } },
        'channels.blocked': { value: ['paper'], default: [] },
      },
      (put) => bodies.push(put),
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('switch', { name: 'Apple Wallet allowed' }));
    await waitFor(() =>
      expect(bodies[0]).toMatchObject({
        scope: 'org:o1',
        values: { 'channels.blocked': ['paper', 'apple'] },
      }),
    );
    await user.click(screen.getByRole('switch', { name: 'Linked NFC allowed' }));
    await waitFor(() =>
      expect(bodies[1]).toMatchObject({ values: { 'nfc.tags': { enabled: true } } }),
    );
  });

  it('keeps platform-only settings off the organization page', async () => {
    await setup({ 'email.buddy': { value: false, default: false } });
    await screen.findByLabelText('Scans').catch(() => undefined);
    expect(screen.queryByLabelText('Refresh cooldown')).toBeNull();
    expect(screen.queryByLabelText('Magic-link sign-in')).toBeNull();
  });

  it('shows created, id and the signing identity with a link to Wallet accounts', async () => {
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
    expect(link).toHaveAttribute('href', '/admin/o/o1/wallet-accounts');
    expect(screen.getAllByText('o1').length).toBeGreaterThan(0);
    expect(screen.getByText('Created')).toBeInTheDocument();
  });
});
