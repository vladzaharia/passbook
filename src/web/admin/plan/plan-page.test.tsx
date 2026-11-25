import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { json, membershipFixture, renderApp } from '@/web/lib/test-utils.tsx';
import { planFixture } from './plan-fixtures.ts';

const open = (plan: unknown) =>
  renderApp('/admin/o/o1/plan', {
    session: 'user',
    memberships: [membershipFixture('o1', { orgName: 'Northwind', capabilities: ['org:read'] })],
    selectedOrg: 'o1',
    handlers: {
      '/api/v1/orgs/o1': () => json({ id: 'o1', name: 'Northwind' }),
      '/api/v1/orgs/o1/plan': () => json(plan),
    },
  });

describe('plan page', () => {
  it('shows each limit with use, no limit as such, and a warning near the cap', async () => {
    await open(planFixture());
    expect(await screen.findByRole('heading', { name: 'Standard' })).toBeVisible();
    const limits = within(screen.getByRole('region', { name: 'Limits' }));
    expect(limits.getByText('3,214 of 5,000')).toBeVisible();
    expect(limits.getByText('4 of 25')).toBeVisible();
    expect(limits.getByText('2 · No limit')).toBeVisible();
    // A cap with no count shows the cap alone and no meter.
    expect(limits.getByText('500')).toBeVisible();
    expect(limits.getAllByRole('progressbar')).toHaveLength(3);
    expect(limits.getByRole('progressbar', { name: 'Scanners' })).toHaveAttribute(
      'aria-valuetext',
      '19 of 20',
    );
  });

  it('lists the features the plan has, plainly, and the footer', async () => {
    await open(planFixture());
    const features = within(await screen.findByRole('region', { name: 'Features' }));
    expect(features.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Apple',
      'Google',
      'NFC tags',
      'API access, read only',
    ]);
    expect(features.queryByText(/not included|upgrade/i)).toBeNull();
    expect(features.getByText('Powered by PassBook')).toBeVisible();
  });

  it('says so when the organization has no plan', async () => {
    await open(planFixture({ preset: null, label: null, limits: [], features: [] }));
    expect(await screen.findByText('No plan on this organization.')).toBeVisible();
  });
});
