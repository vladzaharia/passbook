import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { json, membershipFixture, renderApp } from '@/web/lib/test-utils.tsx';

const org = {
  id: 'o1',
  slug: 'acme',
  name: 'Acme Gym',
  status: 'active',
  defaultIdentityId: null,
  branding: {},
  createdAt: 1,
  updatedAt: 1,
  counts: { passes: 0, templates: 0, connections: 0, apiKeys: 0 },
  countsCapped: false,
};
const hold = (over: Record<string, unknown>) => ({
  id: 'h1',
  passId: null,
  passLabel: null,
  placedByKind: 'org',
  placedByLabel: 'Sam',
  reason: 'Inquiry',
  createdAt: 1_700_000_000_000,
  releasedAt: null,
  releasedByLabel: null,
  canRelease: true,
  ...over,
});

function setup(capabilities: string[], holds: unknown[]) {
  return renderApp('/admin/o/o1/retention', {
    session: 'user',
    memberships: [membershipFixture('o1', { capabilities: capabilities as never })],
    handlers: {
      '/api/v1/orgs/o1': () => json(org),
      '/api/v1/orgs/o1/retention/holds': () => json({ items: holds, nextCursor: null }),
      '/api/v1/orgs/o1/retention/receipts': () =>
        json({
          items: [
            {
              id: 'r1',
              cls: 'scans',
              kind: 'sweep',
              ranAt: 1_700_000_000_000,
              cutoffAt: 1,
              policyDays: 396,
              deleted: 12,
              anonymised: 0,
              verified: true,
            },
          ],
          nextCursor: null,
        }),
      '/api/v1/settings': () => json({ items: [], nextCursor: null }),
    },
  });
}

describe('retention page', () => {
  it('an org admin can place and release an org hold', async () => {
    await setup(['org:read', 'org:manage', 'audit:read'], [hold({})]);
    expect(await screen.findByRole('button', { name: 'Place hold' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Release' })).toBeInTheDocument();
  });

  it('a PassBook hold is read-only for the org and says who to ask', async () => {
    await setup(
      ['org:read', 'org:manage', 'audit:read'],
      [hold({ placedByKind: 'platform', placedByLabel: 'PassBook', canRelease: false })],
    );
    expect(await screen.findByText(/PassBook placed this hold/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Release' })).toBeNull();
  });

  it('a reader sees holds and receipts but no way to place or release', async () => {
    await setup(['org:read', 'audit:read'], [hold({})]);
    expect(await screen.findByText('Inquiry', { exact: false })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Place hold' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Release' })).toBeNull();
    expect(
      await screen.findByRole('button', { name: /Download receipt, Scans/ }),
    ).toBeInTheDocument();
  });

  it('a member without audit:read sees no holds or receipts', async () => {
    await setup(['org:read'], []);
    expect(await screen.findByRole('heading', { name: 'Retention' })).toBeInTheDocument();
    expect(screen.queryByText('Legal holds')).toBeNull();
    expect(screen.queryByText('Retention receipts')).toBeNull();
  });

  it('the place hold dialog blocks an empty reason and starts empty after Cancel', async () => {
    const user = userEvent.setup();
    await setup(['org:read', 'org:manage', 'audit:read'], []);
    await user.click(await screen.findByRole('button', { name: 'Place hold' }));
    const dialog = await screen.findByRole('dialog', { name: 'Place hold' });
    await user.click(within(dialog).getByRole('button', { name: 'Place hold' }));
    expect(await within(dialog).findByText('Give a reason.')).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/Reason/), 'Inquiry');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await user.click(await screen.findByRole('button', { name: 'Place hold' }));
    const again = await screen.findByRole('dialog', { name: 'Place hold' });
    expect(within(again).getByLabelText(/Reason/)).toHaveValue('');
    expect(within(again).queryByText('Give a reason.')).toBeNull();
  });
});
