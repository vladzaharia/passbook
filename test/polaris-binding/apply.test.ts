import { beforeEach, describe, expect, it } from 'vitest';
import { captureLogs, ctx, ledger, resetLedger, rows, seedGrant, setup } from './harness.ts';

beforeEach(resetLedger);

describe.each(['v2', 'admin'] as const)('apply (%s layout)', (layout) => {
  const base = layout === 'admin' ? '/api/admin' : '/api';

  it('writes the read plus the role, reads it back, and records a grant', async () => {
    const { api, pocket } = setup(layout);
    pocket.addUser('u1', { groups: ['g-other', 'g-extra'] });
    await expect(api.apply('u1', { add: ['developer'] }, ctx({ ref: 'inv-1' }))).resolves.toEqual({
      added: ['developer'],
      removed: [],
      skipped: [],
      dryRun: false,
    });
    const put = pocket.writes().find((w) => w.method === 'PUT');
    expect(put?.path).toBe(`${base}/users/u1/user-groups`);
    expect(put?.body).toEqual({ userGroupIds: ['g-other', 'g-extra', 'g-dev'] });
    expect(pocket.s.seen.at(-1)?.path).toBe(`${base}/users/u1/groups`);
    expect(await rows('idp_grants')).toMatchObject([
      { subject: 'u1', role: 'developer', source: 'added', ref: 'inv-1', removed_at: null },
    ]);
    expect(await rows('idp_subjects')).toMatchObject([{ subject: 'u1', class: 'linked' }]);
  });

  it('carries groups outside the registry through every write, byte for byte and in order', async () => {
    const { api, pocket } = setup(layout);
    pocket.addUser('u1', { groups: ['g-extra', 'g-dev', 'g-other'] });
    await seedGrant('u1', 'developer');
    await api.apply('u1', { add: ['console'], remove: ['developer'] }, ctx());
    expect(pocket.writes().at(-1)?.body).toEqual({
      userGroupIds: ['g-extra', 'g-other', 'g-console'],
    });
    await api.apply('u1', { add: ['developer'] }, ctx());
    await api.apply('u1', { remove: ['console'] }, ctx());
    expect(pocket.s.users.get('u1')?.groups).toEqual(['g-extra', 'g-other', 'g-dev']);
  });

  it('leaves an account that already has the role alone, with no grant', async () => {
    const { api, pocket } = setup(layout);
    pocket.addUser('u1', { groups: ['g-dev'] });
    await expect(api.apply('u1', { add: ['developer'] }, ctx())).resolves.toMatchObject({
      added: [],
      skipped: [{ role: 'developer', reason: 'already' }],
    });
    expect(pocket.writes()).toHaveLength(0);
    expect(await rows('idp_grants')).toHaveLength(0);
  });

  it('refuses admins, protected-group members, the key user and disabled accounts (adds), with no write', async () => {
    const { api, pocket } = setup(layout);
    pocket.addUser('adm', { isAdmin: true });
    pocket.addUser('pa', { groups: ['g-admins'] });
    pocket.addUser('off', { disabled: true });
    for (const who of ['adm', 'pa', 'key-user']) {
      await expect(api.apply(who, { add: ['developer'] }, ctx())).rejects.toThrow(/^IDP_REFUSED/);
      await seedGrant(who, 'console');
      await expect(api.apply(who, { remove: ['console'] }, ctx())).rejects.toThrow(/^IDP_REFUSED/);
    }
    await expect(api.apply('off', { add: ['developer'] }, ctx())).rejects.toThrow(/^IDP_REFUSED/);
    expect(pocket.writes()).toHaveLength(0);
    expect((await ledger()).filter((r) => r.phase === 'refused')).toHaveLength(7);
  });

  it('still removes a role from a disabled account', async () => {
    const { api, pocket } = setup(layout);
    pocket.addUser('off', { disabled: true, groups: ['g-dev'] });
    await seedGrant('off');
    await expect(api.apply('off', { remove: ['developer'] }, ctx())).resolves.toMatchObject({
      removed: ['developer'],
    });
  });

  it('refuses a user answer without both flags: unknown is not "not an admin"', async () => {
    const { api, pocket } = setup(layout);
    pocket.addUser('u1');
    pocket.s.userDto = ({ isAdmin: _drop, ...rest }) => rest;
    await expect(api.apply('u1', { add: ['developer'] }, ctx())).rejects.toThrow(/^IDP_UPSTREAM/);
    expect(pocket.writes()).toHaveLength(0);
  });

  it('answers an unknown account as not found', async () => {
    const { api } = setup(layout);
    await expect(api.apply('ghost', { add: ['developer'] }, ctx())).rejects.toThrow(
      /^IDP_NOT_FOUND/,
    );
  });

  it('raises a drift alert when the read-back differs, and never retries', async () => {
    const { api, pocket } = setup(layout);
    pocket.addUser('u1');
    pocket.s.putTransform = (ids) => [...ids, 'g-admins'];
    const logs = await captureLogs(() => api.apply('u1', { add: ['developer'] }, ctx()));
    expect(String(logs.error)).toMatch(/^IdpError: IDP_DRIFT/);
    expect(pocket.writes().filter((w) => w.method === 'PUT')).toHaveLength(1);
    expect(logs.lines.find((l) => l.includes('binding.drift'))).toContain('"subject":"u1"');
  });

  it('removes only a role it added, writing the read minus the group, and spends the grant', async () => {
    const { api, pocket } = setup(layout);
    pocket.addUser('u1');
    await api.apply('u1', { add: ['developer'] }, ctx());
    await expect(
      api.apply('u1', { remove: ['developer'] }, ctx({ reason: 'last_sponsor_ended' })),
    ).resolves.toMatchObject({ removed: ['developer'] });
    expect(pocket.writes().at(-1)?.body).toEqual({ userGroupIds: ['g-other'] });
    expect(await rows('idp_grants')).toMatchObject([
      { removed_reason: 'last_sponsor_ended', removed_at: expect.any(Number) },
    ]);
    const before = pocket.s.seen.length;
    await expect(api.apply('u1', { remove: ['developer'] }, ctx())).resolves.toMatchObject({
      skipped: [{ role: 'developer', reason: 'not_ours' }],
    });
    expect(pocket.s.seen).toHaveLength(before);
  });

  it('answers not_ours for a role the owner added by hand, without a call', async () => {
    const { api, pocket } = setup(layout);
    pocket.addUser('u1', { groups: ['g-other', 'g-dev'] });
    await expect(api.apply('u1', { remove: ['developer'] }, ctx())).resolves.toMatchObject({
      removed: [],
      skipped: [{ role: 'developer', reason: 'not_ours' }],
    });
    expect(pocket.s.seen.filter((s) => s.path.includes('/users/u1'))).toHaveLength(0);
    expect(pocket.s.users.get('u1')?.groups).toContain('g-dev');
    expect((await ledger()).at(-1)).toMatchObject({ phase: 'refused', status: 'not_ours' });
  });

  it('removes an external role only with an override, and ledgers it', async () => {
    const { api, pocket } = setup(layout);
    pocket.addUser('u1', { groups: ['g-other', 'g-dev'] });
    await expect(
      api.apply(
        'u1',
        { remove: ['developer'] },
        ctx({ override: true, actor: { kind: 'user', id: 'a1' } }),
      ),
    ).resolves.toMatchObject({ removed: ['developer'] });
    expect(pocket.s.users.get('u1')?.groups).toEqual(['g-other']);
    expect(await rows('idp_grants')).toMatchObject([
      { source: 'override', removed_reason: 'override' },
    ]);
    expect((await ledger()).filter((r) => r.delta === 'override').length).toBeGreaterThan(0);
  });

  it('refuses an override that adds, or that removes nothing', async () => {
    const { api, pocket } = setup(layout);
    pocket.addUser('u1');
    await expect(api.apply('u1', { add: ['developer'] }, ctx({ override: true }))).rejects.toThrow(
      /^IDP_REFUSED/,
    );
    await expect(
      api.apply('u1', { add: ['developer'], remove: ['console'] }, ctx({ override: true })),
    ).rejects.toThrow(/^IDP_REFUSED/);
    expect(pocket.s.seen).toHaveLength(0);
  });

  it('closes a grant whose role or account is already gone', async () => {
    const { api, pocket } = setup(layout);
    pocket.addUser('u1');
    await seedGrant('u1');
    await seedGrant('ghost');
    await expect(api.apply('u1', { remove: ['developer'] }, ctx())).resolves.toMatchObject({
      skipped: [{ role: 'developer', reason: 'absent' }],
    });
    await expect(api.apply('ghost', { remove: ['developer'] }, ctx())).rejects.toThrow(
      /^IDP_NOT_FOUND/,
    );
    expect(pocket.writes()).toHaveLength(0);
    expect(
      (await rows('idp_grants')).filter((g) => g.subject === 'u1')[0]?.removed_at,
    ).not.toBeNull();
  });

  it.each(['../x', 'a/b', '', 'x'.repeat(65), 'a b', 'me'])(
    'refuses the subject %j',
    async (sub) => {
      const { api, pocket } = setup(layout);
      await expect(api.apply(sub, { add: ['developer'] }, ctx())).rejects.toThrow(/^IDP_REFUSED/);
      expect(pocket.s.seen).toHaveLength(0);
    },
  );

  it('takes no group: ids, protected roles and unmapped roles are refused before any call', async () => {
    const { api, pocket } = setup(layout);
    pocket.addUser('u1');
    const hostile = api.apply as unknown as (...a: unknown[]) => Promise<unknown>;
    for (const delta of [
      { add: ['g-admins'] },
      { add: ['platform_admin'] },
      { add: ['users'] },
      { add: [{ id: 'g-admins' }] },
      { add: 'developer' },
      { groupIds: ['g-admins'] },
      {},
      { add: ['developer'], remove: ['developer'] },
    ])
      await expect(hostile('u1', delta, ctx())).rejects.toThrow(/^IDP_REFUSED/);
    // support is a role, but this deployment's registry does not map it
    await expect(api.apply('u1', { add: ['support'] }, ctx())).rejects.toThrow(
      /^IDP_REFUSED: Role support is not mapped/,
    );
    expect(pocket.s.seen).toHaveLength(0);
  });

  it.each([
    ['no context', undefined],
    ['no actor', { ref: 'r1', reason: 'sync' }],
    ['a bad kind', { ref: 'r1', reason: 'sync', actor: { kind: 'admin', id: 'x' } }],
    ['a bad reason', { ref: 'r1', reason: 'Sync Now', actor: { kind: 'user', id: 'x' } }],
    ['a bad ref', { ref: 'a/b', reason: 'sync', actor: { kind: 'user', id: 'x' } }],
    ['a bad flag', { ref: 'r1', reason: 'sync', actor: { kind: 'user', id: 'x' }, dryRun: 'no' }],
  ])('refuses %s', async (_n, bad) => {
    const { api, pocket } = setup(layout);
    const hostile = api.apply as unknown as (...a: unknown[]) => Promise<unknown>;
    await expect(hostile('u1', { add: ['developer'] }, bad)).rejects.toThrow(/^IDP_REFUSED/);
    expect(pocket.s.seen).toHaveLength(0);
  });

  it('ledgers the actor, run, reason, roles and change', async () => {
    const { api, pocket } = setup(layout);
    pocket.addUser('u1');
    await api.apply(
      'u1',
      { add: ['console'] },
      ctx({ ref: 'run-9', reason: 'member_added', actor: { kind: 'key', id: 'k1' } }),
    );
    const [start, end] = (await ledger()).filter((r) => r.method === 'apply');
    expect(start).toMatchObject({
      phase: 'start',
      bucket: 'apply_add',
      caller: 'run-9',
      actor: 'key:k1',
      reason: 'member_added',
      role: 'console',
      delta: '+console',
      target: 'u1',
    });
    expect(end).toMatchObject({ phase: 'end', status: '200' });
  });
});
