import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { json, membershipFixture, renderApp } from '../../lib/test-utils.tsx';
import { ORG, passDetail, passSummary, templateDetail, templateSummary } from './test-fixtures.ts';

const hold = (over: Record<string, unknown>) => ({
  id: 'h1',
  passId: 'p1',
  passLabel: 'Pass 1',
  placedByKind: 'org',
  placedByLabel: 'Sam',
  reason: 'Dispute',
  createdAt: 1,
  releasedAt: null,
  releasedByLabel: null,
  canRelease: true,
  ...over,
});

function open(capabilities: string[], holds: unknown[]) {
  const pass = passDetail({});
  return renderApp(`/admin/o/${ORG.id}/passes/p1`, {
    session: 'admin',
    memberships: [
      membershipFixture(ORG.id, {
        orgName: ORG.name,
        orgSlug: ORG.slug,
        roles: ['org_admin'],
        capabilities: capabilities as never,
      }),
    ],
    selectedOrg: ORG.id,
    handlers: {
      '/api/v1/orgs': () => json({ items: [ORG], nextCursor: null }),
      '/api/v1/templates': () => json({ items: [templateSummary()], nextCursor: null }),
      '/api/v1/templates/tpl1': () => json(templateDetail()),
      '/api/v1/passes': () => json({ items: [passSummary()], nextCursor: null }),
      '/api/v1/passes/p1': () => json(pass),
      [`/api/v1/orgs/${ORG.id}/retention/holds`]: () => json({ items: holds }),
    },
  });
}

const CAN = [
  'org:read',
  'org:manage',
  'passes:read',
  'passes:operate',
  'templates:read',
  'audit:read',
];

describe('pass legal hold', () => {
  it('offers Place hold to an org admin when nothing is held', async () => {
    await open(CAN, []);
    expect(await screen.findByRole('button', { name: 'Place hold' })).toBeInTheDocument();
  });

  it('shows the hold on the pass and lets the admin release it', async () => {
    await open(CAN, [hold({})]);
    expect(await screen.findByText('On this pass')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Release' })).toBeInTheDocument();
  });

  it('a PassBook hold on the pass is read-only', async () => {
    await open(CAN, [hold({ placedByKind: 'platform', canRelease: false })]);
    expect(await screen.findByText('On this pass')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Release' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Place hold' })).toBeNull();
  });

  it('an org-wide hold shows on every pass; a reader cannot act', async () => {
    await open(
      ['org:read', 'passes:read', 'templates:read', 'audit:read'],
      [hold({ passId: null })],
    );
    expect(await screen.findByText('Whole organization')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Place hold' })).toBeNull();
  });

  it('shows nothing without audit:read', async () => {
    await open(['org:read', 'passes:read', 'templates:read'], []);
    await screen.findByText('Pass context');
    expect(screen.queryByText('Legal hold')).toBeNull();
  });
});
