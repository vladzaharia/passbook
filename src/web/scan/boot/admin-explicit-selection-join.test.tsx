import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { json, sessionFixture } from '../../lib/test-utils.tsx';
import {
  chooseOrg,
  cleanupExplicitSelection,
  expectCsrf,
  expectNoGlobalOrgs,
  joinedScope,
  membership,
  requests,
  setup,
  southSession,
} from './admin-explicit-selection-test-fixtures.ts';

afterEach(cleanupExplicitSelection);

describe('scanner admin session writes', () => {
  it('joins a selected organization’s session using the current identity and CSRF token', async () => {
    const s = setup();
    const user = await chooseOrg();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Join session' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Join session' }));
    await waitFor(() => expect(s.onScope).toHaveBeenCalledWith(joinedScope));
    expect(requests(s.fetch, '/api/v1/session')).toHaveLength(1);
    expect(requests(s.fetch, '/api/v1/orgs/memberships/me').length).toBeGreaterThanOrEqual(2);
    const join = requests(s.fetch, '/api/v1/scanning-sessions/join', 'POST');
    expect(join).toHaveLength(1);
    expect(JSON.parse(String(join[0]?.[1]?.body))).toEqual({
      sessionId: 'session-1',
      deviceKey: expect.any(String),
    });
    expectCsrf(join[0]?.[1]);
    expectNoGlobalOrgs(s.fetch);
  });

  it('creates and joins a session only after explicit selection, with CSRF on both writes', async () => {
    const s = setup({ lists: { o1: [] } });
    const user = await chooseOrg();
    const name = await screen.findByRole('textbox', { name: 'New session name' });
    await user.clear(name);
    await user.type(name, 'Member entrance');
    await user.click(screen.getByRole('button', { name: 'Create and join' }));
    await waitFor(() => expect(s.onScope).toHaveBeenCalledWith(joinedScope));
    expect(requests(s.fetch, '/api/v1/session')).toHaveLength(1);
    const create = requests(s.fetch, '/api/v1/scanning-sessions', 'POST');
    const join = requests(s.fetch, '/api/v1/scanning-sessions/join', 'POST');
    expect(create).toHaveLength(1);
    expect(join).toHaveLength(1);
    expect(JSON.parse(String(create[0]?.[1]?.body))).toMatchObject({
      orgId: 'o1',
      name: 'Member entrance',
      timeZone: expect.any(String),
    });
    expect(JSON.parse(String(join[0]?.[1]?.body))).toMatchObject({ sessionId: 'session-1' });
    expectCsrf(create[0]?.[1]);
    expectCsrf(join[0]?.[1]);
    expectNoGlobalOrgs(s.fetch);
  });

  it('rejects a changed signed-in user before creating or joining', async () => {
    const identity = sessionFixture('user');
    if (!identity.authenticated) throw new Error('Expected a signed-in fixture.');
    const s = setup({ identity: { ...identity, user: { ...identity.user, id: 'u2' } } });
    const user = await chooseOrg();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Join session' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Join session' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/sign-in changed/i);
    expect(requests(s.fetch, '/api/v1/scanning-sessions', 'POST')).toHaveLength(0);
    expect(requests(s.fetch, '/api/v1/scanning-sessions/join', 'POST')).toHaveLength(0);
    expect(s.onScope).not.toHaveBeenCalled();
  });

  it('does not join a session created for a different organization', async () => {
    const s = setup({ lists: { o1: [] }, createdSession: southSession });
    const user = await chooseOrg();
    await user.click(await screen.findByRole('button', { name: 'Create and join' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/different organization/i);
    expect(requests(s.fetch, '/api/v1/scanning-sessions', 'POST')).toHaveLength(1);
    expect(requests(s.fetch, '/api/v1/scanning-sessions/join', 'POST')).toHaveLength(0);
    expect(s.onScope).not.toHaveBeenCalled();
  });

  it('does not enter a joined scope returned for a different organization', async () => {
    const s = setup({ joined: { ...joinedScope, orgId: 'o2' } });
    const user = await chooseOrg();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Join session' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Join session' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/different organization/i);
    expect(requests(s.fetch, '/api/v1/scanning-sessions/join', 'POST')).toHaveLength(1);
    expect(s.onScope).not.toHaveBeenCalled();
  });

  it('rechecks membership before writing and rejects a just-revoked manager', async () => {
    let count = 0;
    const current = membership('o1', 'Northwind');
    const s = setup({
      membershipResponse: () =>
        json({ items: [count++ === 0 ? current : { ...current, revokedAt: 2 }] }),
    });
    const user = await chooseOrg();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Join session' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Join session' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/access changed/i);
    expect(requests(s.fetch, '/api/v1/orgs/memberships/me').length).toBeGreaterThanOrEqual(2);
    expect(requests(s.fetch, '/api/v1/scanning-sessions', 'POST')).toHaveLength(0);
    expect(requests(s.fetch, '/api/v1/scanning-sessions/join', 'POST')).toHaveLength(0);
    expect(s.onScope).not.toHaveBeenCalled();
    expectNoGlobalOrgs(s.fetch);
  });
});
