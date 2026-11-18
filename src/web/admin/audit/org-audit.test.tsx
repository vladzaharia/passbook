import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import type { OrgCapability } from '@/shared/contracts/org-membership.ts';
import { resetModeForTests } from '@/web/lib/mode.ts';
import { json, membershipFixture, renderApp } from '@/web/lib/test-utils.tsx';

const entry = (id: number, action: string) => ({
  id,
  at: 1_700_000_000_000 + id,
  orgId: 'o1',
  actorType: 'user',
  actorId: 'u1',
  actorLabel: 'Ada Lovelace',
  action,
  targetType: 'pass',
  targetId: `p${id}`,
  targetLabel: `Pass ${id}`,
  requestId: null,
  detail: null,
});
const log = [entry(2, 'pass.void'), entry(1, 'pass.create')];
const handlers = {
  '/api/v1/audit': () => json({ items: log, nextCursor: null }),
};
const member = (capabilities: OrgCapability[]) =>
  membershipFixture('o1', { orgName: 'Northwind', capabilities });
const calls = (mock: { mock: { calls: unknown[][] } }) => mock.mock.calls.map((c) => String(c[0]));

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  };
}

beforeEach(() => vi.stubGlobal('localStorage', memoryStorage()));
afterEach(() => {
  resetModeForTests();
  delete document.documentElement.dataset.theme;
  vi.unstubAllGlobals();
});

describe('organization audit log', () => {
  it('lists one organization, with no platform requests or filters', async () => {
    const { fetchMock } = await renderApp('/admin/audit', {
      session: 'user',
      memberships: [member(['org:read', 'audit:read'])],
      selectedOrg: 'o1',
      handlers,
    });
    expect(await screen.findByRole('heading', { name: 'Audit log', level: 1 })).toBeInTheDocument();
    expect(await screen.findAllByText('Pass 2')).not.toHaveLength(0);
    const urls = calls(fetchMock);
    expect(urls.some((u) => u.startsWith('/api/v1/audit?') && u.includes('orgId=o1'))).toBe(true);
    expect(urls.some((u) => /audit\/platform|\/api\/v1\/orgs\?|\/api\/v1\/users/.test(u))).toBe(
      false,
    );
    expect(screen.queryByText('Organization, people and resources')).toBeNull();
    expect(screen.getByRole('combobox', { name: /^Action/ })).toBeInTheDocument();
  });

  it('filters by action on the server', async () => {
    const user = userEvent.setup();
    const { fetchMock } = await renderApp('/admin/audit', {
      session: 'user',
      memberships: [member(['org:read', 'audit:read'])],
      selectedOrg: 'o1',
      handlers,
    });
    await screen.findAllByText('Pass 2');
    await user.click(screen.getByRole('combobox', { name: /^Action/ }));
    await user.click(await screen.findByRole('option', { name: 'Pass voided' }));
    await waitFor(() =>
      expect(
        calls(fetchMock).some((u) => u.includes('action=pass.void') && u.includes('orgId=o1')),
      ).toBe(true),
    );
  });

  it('is closed to a member without audit:read, and its link is hidden', async () => {
    const { fetchMock } = await renderApp('/admin/audit', {
      session: 'user',
      memberships: [member(['org:read', 'passes:read'])],
      selectedOrg: 'o1',
      handlers,
    });
    expect(
      await screen.findByRole('heading', { name: 'You do not have access', level: 1 }),
    ).toBeInTheDocument();
    expect(calls(fetchMock).some((u) => u.startsWith('/api/v1/audit'))).toBe(false);
    const nav = screen.getByRole('navigation', { name: 'Admin' });
    expect(within(nav).queryByRole('link', { name: 'Audit log' })).toBeNull();
  });

  it('shows the log and API keys links to an organization administrator', async () => {
    await renderApp('/admin/audit', {
      session: 'user',
      memberships: [member(['org:read', 'passes:read', 'audit:read', 'integrations:manage'])],
      selectedOrg: 'o1',
      handlers,
    });
    const nav = await screen.findByRole('navigation', { name: 'Admin' });
    expect(within(nav).getByRole('link', { name: 'Audit log' })).toHaveAttribute(
      'href',
      '/admin/audit?orgId=o1',
    );
    expect(within(nav).getByRole('link', { name: 'API keys' })).toHaveAttribute(
      'href',
      '/admin/api-keys?orgId=o1',
    );
    expect(within(nav).queryByRole('link', { name: 'Status' })).toBeNull();
  });
});

const COMBOS = [1440, 820, 390].flatMap((width) =>
  (['light', 'dark'] as const).map((theme) => [width, theme] as const),
);

describe.each(COMBOS)('organization audit log axe at %i, %s theme', (width, theme) => {
  it('lists entries', async () => {
    document.documentElement.dataset.theme = theme;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    await renderApp('/admin/audit', {
      session: 'user',
      memberships: [member(['org:read', 'audit:read'])],
      selectedOrg: 'o1',
      handlers,
    });
    await screen.findAllByText('Pass 2');
    expect((await axe(document.body)).violations).toEqual([]);
  });
});
