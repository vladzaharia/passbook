import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { OrgPlanDto } from '@/shared/contracts/org-plan.ts';
import { json, membershipFixture, renderApp } from '@/web/lib/test-utils.tsx';
import { planFixture } from '../plan/plan-fixtures.ts';
import { audit, orgActivity, overview } from './overview-fixtures.ts';

const open = (plan: OrgPlanDto) =>
  renderApp('/admin', {
    session: 'user',
    memberships: [
      membershipFixture('o1', { orgName: 'Northwind', capabilities: ['org:read', 'passes:read'] }),
    ],
    selectedOrg: 'o1',
    handlers: {
      '/api/v1/metrics/activity': () => json(orgActivity()),
      '/api/v1/metrics/overview': () => json(overview()),
      '/api/v1/templates': () => json({ items: [], nextCursor: null }),
      '/api/v1/audit': () => json(audit),
      '/api/v1/orgs/o1/plan': () => json(plan),
    },
  });

describe('overview plan notice', () => {
  it('names the fullest limit at 80% or more and links to Plan', async () => {
    await open(
      planFixture({
        limits: [
          { key: 'passes.live', limit: 5000, used: 4100 },
          { key: 'scanning.devices', limit: 20, used: 20 },
          { key: 'templates', limit: 25, used: 4 },
        ],
      }),
    );
    expect(await screen.findByText('Scanners: 20 of 20, and 1 more')).toBeVisible();
    expect(within(screen.getByRole('main')).getByRole('link', { name: 'Plan' })).toHaveAttribute(
      'href',
      '/admin/o/o1/plan',
    );
  });

  it('shows nothing when every limit is under 80%', async () => {
    const { fetchMock } = await open(
      planFixture({
        limits: [
          { key: 'passes.live', limit: 5000, used: 3214 },
          { key: 'members', limit: null, used: 2 },
        ],
      }),
    );
    await screen.findByRole('heading', { name: 'Overview', level: 1 });
    await waitFor(() =>
      expect(fetchMock.mock.calls.map((c) => String(c[0]))).toContain('/api/v1/orgs/o1/plan'),
    );
    expect(within(screen.getByRole('main')).queryByRole('link', { name: 'Plan' })).toBeNull();
    expect(screen.queryByText(/of 5,000/)).toBeNull();
  });
});
