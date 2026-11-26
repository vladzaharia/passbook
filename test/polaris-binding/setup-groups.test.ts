import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { ledger, resetLedger, rows } from './harness.ts';
import { setupCimd, setupCtx, writes } from './setup-harness.ts';

beforeEach(resetLedger);
const run = (r = 'p1') => setupCtx({ ref: r });

describe.each(['v2', 'admin'] as const)('placeRoleGroups (%s layout)', (layout) => {
  it('records the protected groups it finds by exact name, never creating them', async () => {
    const h = setupCimd(layout, { names: true });
    const res = await h.api.placeRoleGroups(run());
    expect(res.roles).toMatchObject({ platform_admin: 'recorded', users: 'recorded' });
    const groups = await rows('idp_groups');
    const rec = groups.find((g) => g.key === 'platform_admin:passbook_platform_admins');
    expect(rec).toMatchObject({
      kind: 'role',
      state: 'live',
      group_id: 'g-admins',
      created_by_binding: 0,
    });
    // wallet_admins does not exist: it is skipped, and nothing is created for it.
    expect(groups.some((g) => String(g.key).includes('wallet_admins'))).toBe(false);
    expect(writes(h).filter((w) => w.startsWith('POST'))).toEqual([]);
  });

  it('reports a protected role with no group as missing and sends no write', async () => {
    const h = setupCimd(layout, { names: true });
    h.pocket.s.missing.add('g-admins');
    const res = await h.api.placeRoleGroups(run());
    expect(res.roles.platform_admin).toBe('missing');
    expect(writes(h)).toEqual([]);
    expect((await rows('idp_groups')).some((g) => String(g.key).startsWith('platform_admin'))).toBe(
      false,
    );
  });

  it('keeps every write refused until the platform admin group is placed', async () => {
    const h = setupCimd(layout, { names: true });
    h.pocket.s.missing.add('g-admins');
    await h.api.placeRoleGroups(run());
    const health = await h.api.health();
    expect(health.unsafe).toContain('role_unplaced:platform_admin');
    await expect(h.api.createSignup({ kind: 'member' }, run('s1'))).rejects.toMatchObject({
      code: 'IDP_UNSAFE_CONFIG',
    });
  });

  it('places everything, then writes are safe and a second run is a no-op', async () => {
    const h = setupCimd(layout, { names: true });
    const first = await h.api.placeRoleGroups(run());
    expect(first).toEqual({
      roles: {
        console: 'adopted',
        developer: 'adopted',
        platform_admin: 'recorded',
        users: 'recorded',
      },
      dryRun: false,
    });
    const health = await h.api.health();
    expect(health.unsafe).toEqual([]);
    expect(health.groups).toMatchObject({
      console: 'passbook_console',
      platform_admin: 'passbook_platform_admins',
    });
    const before = h.pocket.s.seen.length;
    h.clock.now += 61_000;
    const again = await h.api.placeRoleGroups(run('p2'));
    expect(Object.values(again.roles).every((v) => v === 'already')).toBe(true);
    expect(h.pocket.s.seen.slice(before).every((r) => r.method === 'GET')).toBe(true);
  });

  it('creates a writable group that does not exist and lets the client allow it', async () => {
    const h = setupCimd(layout, { names: true });
    h.pocket.s.missing.add('g-console');
    const res = await h.api.placeRoleGroups(run());
    expect(res.roles.console).toBe('created');
    expect(writes(h).map((w) => w.split(' ')[0])).toEqual(['POST', 'PUT']);
    const row = (await rows('idp_groups')).find((g) => g.key === 'console');
    expect(row).toMatchObject({ state: 'live', created_by_binding: 1, name: 'passbook_console' });
    expect(h.pocket.s.meta.get(String(row?.group_id))?.clients).toEqual([
      'https://passbook.mobile/auth/oidc/client-metadata.json',
    ]);
  });

  it.each([
    [
      'another app allows it',
      (h: ReturnType<typeof setupCimd>) =>
        h.pocket.s.meta.set('g-dev', {
          friendly: 'd',
          createdAt: 0,
          claims: [],
          clients: ['other-app'],
        }),
    ],
    [
      'it carries a foreign claim',
      (h: ReturnType<typeof setupCimd>) =>
        h.pocket.s.meta.set('g-dev', {
          friendly: 'd',
          createdAt: 0,
          claims: [{ key: 'plan', value: 'x' }],
          clients: [],
        }),
    ],
  ])('does not adopt a writable group when %s', async (_n, arrange) => {
    const h = setupCimd(layout, { names: true });
    arrange(h);
    const res = await h.api.placeRoleGroups(run());
    expect(res.roles.developer).toBe('in_use');
    expect(writes(h)).toEqual([]);
    expect((await rows('idp_groups')).some((g) => g.key === 'developer')).toBe(false);
  });

  it('adopts a writable group only this client uses, with passbook_ claims', async () => {
    const h = setupCimd(layout, { names: true });
    h.pocket.s.meta.set('g-dev', {
      friendly: 'd',
      createdAt: 0,
      claims: [{ key: 'passbook_plan', value: 'x' }],
      clients: ['https://passbook.mobile/auth/oidc/client-metadata.json'],
    });
    expect((await h.api.placeRoleGroups(run())).roles.developer).toBe('adopted');
    expect((await rows('idp_groups')).find((g) => g.key === 'developer')).toMatchObject({
      state: 'live',
      created_by_binding: 0,
    });
  });

  it('sends nothing on a dry run and records nothing', async () => {
    const h = setupCimd(layout, { names: true });
    h.pocket.s.missing.add('g-console');
    const res = await h.api.placeRoleGroups({ ...run(), dryRun: true });
    expect(res).toMatchObject({
      dryRun: true,
      roles: { console: 'created', platform_admin: 'recorded' },
    });
    expect(writes(h)).toEqual([]);
    expect(await rows('idp_groups')).toEqual([]);
    const l = await ledger();
    expect(l.some((r) => r.phase === 'dry_run' && r.method === 'placeRoleGroups')).toBe(true);
    expect(l.some((r) => r.phase === 'start' && r.bucket === 'preview')).toBe(true);
  });

  it('is not gated by WRITE_MODE: a live call writes while the deployment is in dry run', async () => {
    const h = setupCimd(layout, { names: true, patch: { WRITE_MODE: 'dry_run' } });
    await h.api.placeRoleGroups(run());
    expect((await rows('idp_groups')).length).toBeGreaterThan(0);
  });

  it('stops when frozen, before any request', async () => {
    const h = setupCimd(layout, { names: true });
    await h.api.freeze('check', run('f1'));
    h.pocket.s.seen.length = 0;
    await expect(h.api.placeRoleGroups(run())).rejects.toMatchObject({ code: 'IDP_FROZEN' });
    expect(h.pocket.s.seen).toHaveLength(0);
  });

  it('stops a create when a freeze lands mid call', async () => {
    const h = setupCimd(layout, { names: true });
    h.pocket.s.missing.add('g-console');
    let frozen = false;
    // The owner pauses changes while the call is still reading: the create must not go out.
    h.pocket.s.hook = async () => {
      if (frozen) return;
      frozen = true;
      await env.DB.prepare(
        "INSERT INTO idp_freezes (at, reason, actor) VALUES (1, 'x', 'o')",
      ).run();
    };
    await expect(h.api.placeRoleGroups(run())).rejects.toMatchObject({ code: 'IDP_FROZEN' });
    expect(h.pocket.writes()).toEqual([]);
  });

  it('refuses a name that is not unique', async () => {
    const h = setupCimd(layout, { names: true });
    h.pocket.s.override = (method, path) =>
      method === 'GET' && path.includes('search=wallet_admins')
        ? {
            data: [
              { id: 'a1', name: 'wallet_admins' },
              { id: 'a2', name: 'wallet_admins' },
            ],
          }
        : undefined;
    await expect(h.api.placeRoleGroups(run())).rejects.toMatchObject({ code: 'IDP_CONFLICT' });
    expect(await rows('idp_groups')).toEqual([]);
  });

  it('budgets creates in group_write', async () => {
    const h = setupCimd(layout, { names: true });
    h.pocket.s.missing.add('g-console');
    h.pocket.s.missing.add('g-dev');
    await h.api.placeRoleGroups(run('b1'));
    await h.api.placeRoleGroups(run('b2'));
    await expect(h.api.placeRoleGroups(run('b3'))).rejects.toMatchObject({ code: 'IDP_BUDGET' });
  });

  it('records never change or go away', async () => {
    const h = setupCimd(layout, { names: true });
    await h.api.placeRoleGroups(run());
    const key = 'platform_admin:passbook_platform_admins';
    await expect(
      env.DB.prepare("UPDATE idp_groups SET name = 'x' WHERE key = ?").bind(key).run(),
    ).rejects.toThrow();
    await expect(
      env.DB.prepare("UPDATE idp_groups SET group_id = 'g-other' WHERE key = ?").bind(key).run(),
    ).rejects.toThrow();
    await expect(
      env.DB.prepare('DELETE FROM idp_groups WHERE key = ?').bind(key).run(),
    ).rejects.toThrow();
  });
});
