import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { json, membershipFixture, renderApp } from '../../lib/test-utils.tsx';
import {
  connectionDetail,
  ORG,
  passDetail,
  passSummary,
  templateDetail,
  templateSummary,
} from './test-fixtures.ts';

const orgScope = {
  memberships: [membershipFixture(ORG.id, { orgName: ORG.name, orgSlug: ORG.slug })],
  selectedOrg: ORG.id,
};

function open(tab: string, over: Record<string, unknown> = {}) {
  const pass = passDetail({
    mode: 'test',
    holderState: 'owned',
    holderEmail: 'a@b.co',
    blockedUsers: [{ id: 'u9', name: 'Blocked' }],
    ...over,
  });
  return renderApp(`/admin/passes/p1?tab=${tab}`, {
    session: 'admin',
    ...orgScope,
    handlers: {
      '/api/v1/orgs': () => json({ items: [ORG], nextCursor: null }),
      '/api/v1/templates': () => json({ items: [templateSummary()], nextCursor: null }),
      '/api/v1/templates/tpl1': () => json(templateDetail()),
      '/api/v1/passes': () => json({ items: [passSummary()], nextCursor: null }),
      '/api/v1/passes/p1': () => json(pass),
      '/api/v1/passes/p1/assets': () => json({ items: [] }),
      '/api/v1/delivery': () => json({ items: [] }),
      '/api/v1/bundles': () => json({ items: [], nextCursor: null }),
      '/api/v1/connections/c1': () => json(connectionDetail()),
    },
  });
}

describe('pass of the other mode: read-only tabs', () => {
  it('holder: no Change, Allow again is disabled', async () => {
    await open('holder');
    expect(await screen.findByRole('button', { name: 'Allow again' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Change' })).not.toBeInTheDocument();
  });

  it('delivery: Send email is disabled', async () => {
    await open('delivery');
    expect(await screen.findByRole('button', { name: 'Send email' })).toBeDisabled();
  });
});

describe('pass of the other mode: connection', () => {
  it('bound: Change is disabled', async () => {
    await open('connection', { connectionId: 'c1', externalRef: 'r1' });
    expect(await screen.findByRole('button', { name: 'Change' })).toBeDisabled();
  });
});
