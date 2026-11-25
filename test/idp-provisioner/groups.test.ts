import { beforeEach, describe, expect, it } from 'vitest';
import { captureLogs, ledger, resetLedger, rows, seedGrant, setup } from './harness.ts';

beforeEach(resetLedger);

describe.each(['v2', 'admin'] as const)('group edits (%s layout)', (layout) => {
  const base = layout === 'admin' ? '/api/admin' : '/api';

  it('writes the group read plus the developers group, reads it back, and records a grant', async () => {
    const { api, pocket } = setup(layout);
    pocket.addUser('u1', { groups: ['g-other', 'g-admins'] });
    await expect(api.addDeveloper('u1', 'inv-1')).resolves.toBe('added');
    const put = pocket.writes().find((w) => w.method === 'PUT');
    expect(put?.path).toBe(`${base}/users/u1/user-groups`);
    expect(put?.body).toEqual({ userGroupIds: ['g-other', 'g-admins', 'g-dev'] });
    const gets = pocket.s.seen.filter((s) => s.path === `${base}/users/u1/groups`);
    expect(gets).toHaveLength(2);
    expect(pocket.s.seen.at(-1)?.path).toBe(`${base}/users/u1/groups`);
    expect(await rows('idp_grants')).toMatchObject([
      { subject: 'u1', source: 'added', removed_at: null },
    ]);
  });

  it('leaves an account that already has the group alone, with no grant', async () => {
    const { api, pocket } = setup(layout);
    pocket.addUser('u1', { groups: ['g-dev'] });
    await expect(api.addDeveloper('u1', 'inv-1')).resolves.toBe('already');
    expect(pocket.writes()).toHaveLength(0);
    expect(await rows('idp_grants')).toHaveLength(0);
  });

  it('refuses Pocket ID admins and disabled users, in both directions of a write', async () => {
    const { api, pocket } = setup(layout);
    pocket.addUser('adm', { isAdmin: true });
    pocket.addUser('off', { disabled: true });
    await expect(api.addDeveloper('adm', 'r1')).rejects.toThrow(/^IDP_REFUSED/);
    await expect(api.addDeveloper('off', 'r1')).rejects.toThrow(/^IDP_REFUSED/);
    await seedGrant('adm');
    await expect(api.removeDeveloper('adm', 'removed')).rejects.toThrow(/^IDP_REFUSED/);
    expect(pocket.writes()).toHaveLength(0);
    expect((await ledger()).filter((r) => r.phase === 'refused')).toHaveLength(3);
  });

  it('refuses a user answer without both flags: unknown is not "not an admin"', async () => {
    const { api, pocket } = setup(layout);
    pocket.addUser('u1');
    pocket.s.userDto = ({ isAdmin: _drop, ...rest }) => rest;
    await expect(api.addDeveloper('u1', 'r1')).rejects.toThrow(/^IDP_UPSTREAM/);
    expect(pocket.writes()).toHaveLength(0);
  });

  it('answers an unknown account as not found', async () => {
    const { api } = setup(layout);
    await expect(api.addDeveloper('ghost', 'r1')).rejects.toThrow(/^IDP_NOT_FOUND/);
  });

  it('raises a drift alert when the read-back differs, and never retries', async () => {
    const { api, pocket } = setup(layout);
    pocket.addUser('u1');
    pocket.s.putTransform = (ids) => [...ids, 'g-admins'];
    const logs = await captureLogs(() => api.addDeveloper('u1', 'r1'));
    expect(String(logs.error)).toMatch(/^IdpError: IDP_DRIFT/);
    expect(pocket.writes().filter((w) => w.method === 'PUT')).toHaveLength(1);
    const alertLine = logs.lines.find((l) => l.includes('provisioner.drift'));
    expect(alertLine).toContain('"subject":"u1"');
  });

  it('removes the group it added, writing the read minus the group', async () => {
    const { api, pocket } = setup(layout);
    pocket.addUser('u1');
    await api.addDeveloper('u1', 'r1');
    await expect(api.removeDeveloper('u1', 'last_sponsor_ended')).resolves.toBe('removed');
    const puts = pocket.writes().filter((w) => w.method === 'PUT');
    expect(puts.at(-1)?.body).toEqual({ userGroupIds: ['g-other'] });
    expect((await rows('idp_grants'))[0]?.removed_at).not.toBeNull();
    // the grant is spent
    const before = pocket.s.seen.length;
    await expect(api.removeDeveloper('u1', 'again')).resolves.toBe('not_ours');
    expect(pocket.s.seen).toHaveLength(before);
  });

  it('answers not_ours for a group the owner added by hand, without a call', async () => {
    const { api, pocket } = setup(layout);
    pocket.addUser('u1', { groups: ['g-other', 'g-dev'] });
    await expect(api.removeDeveloper('u1', 'removed')).resolves.toBe('not_ours');
    expect(pocket.s.seen).toHaveLength(0);
    expect(pocket.s.users.get('u1')?.groups).toContain('g-dev');
    expect((await ledger()).at(-1)).toMatchObject({ phase: 'refused', status: 'not_ours' });
  });

  it('closes a grant whose group or account is already gone', async () => {
    const { api, pocket } = setup(layout);
    pocket.addUser('u1');
    await seedGrant('u1');
    await seedGrant('ghost');
    await expect(api.removeDeveloper('u1', 'removed')).resolves.toBe('absent');
    await expect(api.removeDeveloper('ghost', 'removed')).resolves.toBe('absent');
    expect(pocket.writes()).toHaveLength(0);
    expect((await rows('idp_grants')).every((g) => g.removed_at !== null)).toBe(true);
  });

  it.each(['../x', 'a/b', '', 'x'.repeat(65), 'a b'])('refuses the subject %j', async (sub) => {
    const { api, pocket } = setup(layout);
    await expect(api.addDeveloper(sub, 'r1')).rejects.toThrow(/^IDP_REFUSED/);
    await expect(api.removeDeveloper(sub, 'removed')).rejects.toThrow(/^IDP_REFUSED/);
    expect(pocket.s.seen).toHaveLength(0);
  });
});
