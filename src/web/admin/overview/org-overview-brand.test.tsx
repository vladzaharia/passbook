import { screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrgCapability } from '@/shared/contracts/org-membership.ts';
import { newOrgFacts, readyFacts, viewOf } from '@/shared/pass-setup-test-fixtures.ts';
import { resetModeForTests } from '@/web/lib/mode.ts';
import { json, membershipFixture, renderApp } from '@/web/lib/test-utils.tsx';
import { resetShownCounts } from './count.ts';
import { audit, memoryStorage, orgActivity, overview } from './overview-fixtures.ts';

const member = (caps?: OrgCapability[]) =>
  membershipFixture('o1', {
    orgName: 'Northwind',
    capabilities: caps ?? [
      'org:read',
      'passes:read',
      'audit:read',
      'passes:operate',
      'templates:author',
    ],
  });
const emptySetup = {
  orgs: 1,
  assignedTemplates: 0,
  passes: 0,
  approvedTemplates: 0,
  releasedTemplates: 0,
  walletPasses: 0,
  passEmailsSent: 0,
  latestPassId: null,
  scanners: 0,
};
const doneSetup = { ...emptySetup, assignedTemplates: 1, walletPasses: 1, releasedTemplates: 1 };
const handlers = (activity: unknown, setup: typeof emptySetup) => ({
  '/api/v1/metrics/activity': () => json(activity),
  '/api/v1/metrics/overview': () => json(overview({ setup })),
  '/api/v1/templates': () => json({ items: [], nextCursor: null }),
  '/api/v1/audit': () => json({ ...audit, items: audit.items.map((e) => ({ ...e, orgId: 'o1' })) }),
});

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  resetShownCounts();
});
afterEach(() => {
  resetModeForTests();
  delete document.documentElement.dataset.theme;
  vi.unstubAllGlobals();
});

describe('brand and channels beside the first pass', () => {
  const withSetup = (setup: () => Response, done = false) => ({
    ...handlers(orgActivity({ templates: [] }), done ? doneSetup : emptySetup),
    '/api/v1/orgs/o1/pass-setup': setup,
  });
  const open = (h: ReturnType<typeof withSetup>, caps?: OrgCapability[]) =>
    renderApp('/admin', {
      session: 'user',
      memberships: [member(caps)],
      selectedOrg: 'o1',
      handlers: h,
    });

  it('lists the count and the first three to-dos under the path, and never gates it', async () => {
    await open(withSetup(() => json(viewOf(newOrgFacts()))));
    const path = await screen.findByRole('region', { name: 'First pass' });
    const row = await within(path).findByText('Brand and channels');
    expect(row.parentElement).toHaveTextContent('3 to do · Logo · Icon · Support');
    expect(within(path).getByRole('link', { name: 'Open' })).toHaveAttribute(
      'href',
      '/admin/o/o1/brand',
    );
    // Not a path step, and the blueprint step is still the active one.
    expect(within(path).getAllByRole('listitem')).toHaveLength(3);
    expect(within(path).getByRole('link', { name: 'All blueprints' })).toBeVisible();
  });

  it('moves into the Next row once the path is done', async () => {
    await open(withSetup(() => json(viewOf(newOrgFacts())), true));
    const next = await screen.findByRole('region', { name: 'First pass is live' });
    await within(next).findByText('Brand and channels');
    expect(within(next).getByRole('link', { name: 'Open' })).toHaveAttribute(
      'href',
      '/admin/o/o1/brand',
    );
    expect(within(next).getByRole('link', { name: 'New pass' })).toBeVisible();
  });

  it('shows nothing when nothing is left to do', async () => {
    await open(withSetup(() => json(viewOf(readyFacts()))));
    const path = await screen.findByRole('region', { name: 'First pass' });
    await new Promise((r) => setTimeout(r, 50));
    expect(within(path).queryByText('Brand and channels')).toBeNull();
    expect(within(path).queryByText('All set')).toBeNull();
  });

  it('shows nothing when the checks fail or the member cannot read them', async () => {
    await open(withSetup(() => json({ title: 'Forbidden', status: 403 }, 403)));
    const path = await screen.findByRole('region', { name: 'First pass' });
    await new Promise((r) => setTimeout(r, 50));
    expect(within(path).queryByText('Brand and channels')).toBeNull();
    expect(within(path).getByRole('link', { name: 'All blueprints' })).toBeVisible();
  });

  it('shows nothing while the checks load', async () => {
    await open(withSetup(() => new Promise<Response>(() => {}) as unknown as Response));
    const path = await screen.findByRole('region', { name: 'First pass' });
    expect(within(path).queryByText('Brand and channels')).toBeNull();
  });
});
