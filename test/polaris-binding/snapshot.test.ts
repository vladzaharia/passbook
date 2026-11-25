import { beforeEach, describe, expect, it } from 'vitest';
import { ctx, ledger, resetLedger, rows, seedGrant, setup } from './harness.ts';

beforeEach(resetLedger);

describe.each(['v2', 'admin'] as const)('snapshot (%s layout)', (layout) => {
  const base = layout === 'admin' ? '/api/admin' : '/api';

  it('reads every registry group and marks which members PassBook granted', async () => {
    const { api, pocket } = setup(layout);
    pocket.addUser('u1', { groups: ['g-dev'] });
    pocket.addUser('u2', { groups: ['g-dev', 'g-console'] });
    pocket.addUser('adm', { isAdmin: true, groups: ['g-admins'] });
    await seedGrant('u1');
    const snap = await api.snapshot(ctx());
    expect(pocket.s.seen.map((s) => s.path)).toEqual(
      ['g-console', 'g-dev', 'g-admins'].map((g) => `${base}/user-groups/${g}`),
    );
    expect(snap.roles.developer?.members).toEqual([
      { subject: 'u1', disabled: false, isAdmin: false, grant: true },
      { subject: 'u2', disabled: false, isAdmin: false, grant: false },
    ]);
    expect(snap.roles.platform_admin?.members).toMatchObject([{ subject: 'adm', isAdmin: true }]);
    expect(snap.ended).toEqual([]);
    expect(pocket.writes()).toHaveLength(0);
  });

  it('notes members it did not add as external, never an admin', async () => {
    const { api, pocket } = setup(layout);
    pocket.addUser('u2', { groups: ['g-console'] });
    pocket.addUser('adm', { isAdmin: true, groups: ['g-console'] });
    await api.snapshot(ctx());
    expect(await rows('idp_subjects')).toMatchObject([{ subject: 'u2', class: 'external' }]);
  });

  it('ends a grant whose member left the group, in its own D1 only', async () => {
    const { api, pocket } = setup(layout);
    pocket.addUser('u1', { groups: [] });
    pocket.addUser('u2', { groups: ['g-dev'] });
    await seedGrant('u1');
    await seedGrant('u2');
    const snap = await api.snapshot(ctx());
    expect(snap.ended).toEqual([{ subject: 'u1', role: 'developer' }]);
    expect(await rows('idp_grants')).toMatchObject([
      { subject: 'u1', removed_reason: 'idp_removed', removed_at: expect.any(Number) },
      { subject: 'u2', removed_at: null },
    ]);
    expect(pocket.writes()).toHaveLength(0);
  });

  it('changes nothing when any group read fails or comes back malformed', async () => {
    const { api, pocket, clock } = setup(layout);
    pocket.addUser('u1', { groups: [] });
    await seedGrant('u1');
    pocket.s.failWith = { match: /user-groups\/g-admins/, status: 500 };
    await expect(api.snapshot(ctx())).rejects.toThrow(/^IDP_UPSTREAM/);
    pocket.s.failWith = undefined;
    clock.now += 61_000;
    pocket.s.missing.add('g-admins');
    await expect(api.snapshot(ctx({ ref: 'run-2' }))).rejects.toThrow(/^IDP_NOT_FOUND/);
    expect((await rows('idp_grants'))[0]?.removed_at).toBeNull();
  });

  it('ledgers the call and sends no write', async () => {
    const { api } = setup(layout);
    await api.snapshot(ctx({ ref: 'rec-1' }));
    expect((await ledger()).map((r) => [r.phase, r.bucket ?? r.method])).toEqual([
      ['start', 'snapshot'],
      ['start', 'snapshot_group'],
      ['start', 'snapshot_group'],
      ['start', 'snapshot_group'],
      ['end', 'snapshot'],
    ]);
  });
});
