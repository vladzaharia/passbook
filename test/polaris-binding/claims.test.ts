import { beforeEach, describe, expect, it } from 'vitest';
import {
  captureLogs,
  ctx,
  dumpAll,
  ledger,
  resetLedger,
  rows,
  seedCreated,
  seedGrant,
  setup,
} from './harness.ts';

beforeEach(resetLedger);

const SECRET = 'VALUE-SECRET-xyz';
const claim = (key: string, value: string) => ({ key, value });

async function owner(opts: Parameters<typeof setup>[1] = {}, layout: 'v2' | 'admin' = 'v2') {
  const s = setup(layout, opts);
  s.pocket.addUser('u1', { groups: ['g-dev'] });
  await seedCreated('u1');
  return s;
}

describe.each(['v2', 'admin'] as const)('user claims (%s layout)', (layout) => {
  const base = layout === 'admin' ? '/api/admin' : '/api';

  it('merges into the current set, copying every other key and value unchanged and in place', async () => {
    const { api, pocket } = await owner({}, layout);
    const other = [claim('role', 'admin'), claim('Weird Key', ' 12 é'), claim('passbook_old', 'x')];
    pocket.s.users.get('u1')!.claims = other;
    await expect(
      api.setClaims(
        { subject: 'u1' },
        { passbook_tier: { type: 'text', value: 'gold' }, passbook_old: null },
        ctx(),
      ),
    ).resolves.toEqual({ set: ['passbook_tier'], removed: ['passbook_old'], dryRun: false });
    const put = pocket.writes().find((w) => w.method === 'PUT');
    expect(put?.path).toBe(`${base}/custom-claims/user/u1`);
    expect(put?.body).toEqual([
      claim('role', 'admin'),
      claim('Weird Key', ' 12 é'),
      claim('passbook_tier', 'gold'),
    ]);
    expect(pocket.s.users.get('u1')?.claims).toEqual(put?.body);
    expect(pocket.s.seen.at(-1)).toMatchObject({ method: 'GET', path: `${base}/users/u1` });
  });

  it('stores typed values so text that looks like JSON stays text', async () => {
    const { api, pocket } = await owner({}, layout);
    await api.setClaims(
      { subject: 'u1' },
      {
        passbook_text: { type: 'text', value: '123' },
        passbook_plain: { type: 'text', value: 'hello' },
        passbook_num: { type: 'number', value: 7 },
        passbook_flag: { type: 'boolean', value: true },
        passbook_obj: { type: 'json', value: { a: [1, 2] } },
      },
      ctx(),
    );
    expect(pocket.s.users.get('u1')?.claims).toEqual([
      claim('passbook_text', '"123"'),
      claim('passbook_plain', 'hello'),
      claim('passbook_num', '7'),
      claim('passbook_flag', 'true'),
      claim('passbook_obj', '{"a":[1,2]}'),
    ]);
    const view = await api.claims({ subject: 'u1' });
    expect(view.claims).toEqual({
      passbook_text: { type: 'text', value: '123' },
      passbook_plain: { type: 'text', value: 'hello' },
      passbook_num: { type: 'number', value: 7 },
      passbook_flag: { type: 'boolean', value: true },
      passbook_obj: { type: 'json', value: { a: [1, 2] } },
    });
  });

  it('reads managed keys only and counts the rest without showing them', async () => {
    const { api, pocket } = await owner({}, layout);
    pocket.s.users.get('u1')!.claims = [
      claim('role', 'admin'),
      claim('passbook_a', 'x'),
      claim('other_app_flag', '1'),
    ];
    expect(await api.claims({ subject: 'u1' })).toEqual({
      claims: { passbook_a: { type: 'text', value: 'x' } },
      otherKeys: 2,
    });
  });

  it.each([
    ['a bare key', { role: { type: 'text', value: 'x' } }],
    ['a reserved key', { sub: { type: 'text', value: 'x' } }],
    ['picture', { picture: { type: 'text', value: 'x' } }],
    ['a bad namespace key', { passbook_Upper: { type: 'text', value: 'x' } }],
    ['an empty value', { passbook_a: { type: 'text', value: '' } }],
    ['a long value', { passbook_a: { type: 'text', value: 'x'.repeat(2049) } }],
    ['a wrong type', { passbook_a: { type: 'number', value: 'x' } }],
    [
      'a deep value',
      { passbook_a: { type: 'json', value: { a: { b: { c: { d: { e: { f: 1 } } } } } } } },
    ],
  ])('refuses %s, and refuses all', async (_n, changes) => {
    const { api, pocket } = await owner({}, layout);
    await expect(
      api.setClaims(
        { subject: 'u1' },
        { passbook_ok: { type: 'text', value: 'fine' }, ...(changes as object) } as never,
        ctx(),
      ),
    ).rejects.toThrow(/^IDP_REFUSED/);
    expect(pocket.writes()).toHaveLength(0);
  });

  it('refuses an empty change set and a non-object', async () => {
    const { api, pocket } = await owner({}, layout);
    const hostile = api.setClaims as unknown as (...a: unknown[]) => Promise<unknown>;
    for (const c of [{}, 'x', null, [1]])
      await expect(hostile({ subject: 'u1' }, c, ctx())).rejects.toThrow(/^IDP_REFUSED/);
    expect(pocket.writes()).toHaveLength(0);
  });

  it('allows a bare key only when the owner lists it, and only on created and linked accounts', async () => {
    const { api, pocket } = await owner({ CLAIM_KEYS: '["tier"]' }, layout);
    await api.setClaims({ subject: 'u1' }, { tier: { type: 'text', value: 'gold' } }, ctx());
    expect(pocket.s.users.get('u1')?.claims).toEqual([claim('tier', 'gold')]);
    pocket.addUser('ext', { groups: ['g-dev'] });
    await api.snapshot(ctx({ ref: 'sn' }));
    expect((await rows('idp_subjects')).find((r) => r.subject === 'ext')?.class).toBe('external');
    await expect(
      api.setClaims({ subject: 'ext' }, { tier: { type: 'text', value: 'x' } }, ctx({ ref: 'r2' })),
    ).rejects.toThrow(/^IDP_REFUSED/);
    await expect(
      api.setClaims(
        { subject: 'ext' },
        { passbook_ok: { type: 'text', value: 'x' } },
        ctx({ ref: 'r3' }),
      ),
    ).resolves.toMatchObject({ set: ['passbook_ok'] });
  });

  it.each([
    ['a reserved key', '["sub"]'],
    ['a passbook_ key', '["passbook_x"]'],
    ['bad json', '['],
    ['picture', '["picture"]'],
  ])('refuses %s in CLAIM_KEYS', async (_n, keys) => {
    const { api } = setup(layout, { CLAIM_KEYS: keys });
    expect((await api.health()).unsafe).toContain('env_claim_keys');
  });

  it('refuses admins, admin group members, the key user, unknown accounts and `me`', async () => {
    const { api, pocket } = setup(layout);
    pocket.addUser('adm', { isAdmin: true });
    pocket.addUser('pa', { groups: ['g-admins'] });
    pocket.addUser('stranger');
    await seedCreated('adm');
    await seedCreated('pa');
    const change = { passbook_a: { type: 'text' as const, value: 'x' } };
    for (const who of ['adm', 'pa', 'stranger', 'key-user', 'me'])
      await expect(
        api.setClaims({ subject: who }, change, ctx({ ref: `r-${who}` })),
      ).rejects.toThrow(/^IDP_REFUSED/);
    await expect(api.claims({ subject: 'stranger' })).rejects.toThrow(/^IDP_REFUSED/);
    expect(pocket.writes()).toHaveLength(0);
  });

  it('takes an owner, never an id or a name', async () => {
    const { api, pocket } = await owner({}, layout);
    const hostile = api.setClaims as unknown as (...a: unknown[]) => Promise<unknown>;
    const c = { passbook_a: { type: 'text', value: 'x' } };
    for (const o of [
      {},
      { subject: 'u1', group: 'console' },
      { group: 'g-dev' },
      { group: 'platform_admin' },
      { group: 'users' },
      'u1',
      null,
    ])
      await expect(hostile(o, c, ctx())).rejects.toThrow(/^IDP_REFUSED/);
    expect(pocket.writes()).toHaveLength(0);
  });

  it('fails closed on a user without a claims list, and raises drift when the whole set differs', async () => {
    const { api, pocket } = await owner({}, layout);
    pocket.s.userDto = ({ customClaims: _c, ...rest }) => rest;
    await expect(
      api.setClaims({ subject: 'u1' }, { passbook_a: { type: 'text', value: 'x' } }, ctx()),
    ).rejects.toThrow(/^IDP_UPSTREAM/);
    expect(pocket.writes()).toHaveLength(0);
    pocket.s.userDto = undefined;
    pocket.s.claimsTransform = (list) => [...list, claim('injected', '1')];
    const logs = await captureLogs(() =>
      api.setClaims(
        { subject: 'u1' },
        { passbook_a: { type: 'text', value: 'x' } },
        ctx({ ref: 'r2' }),
      ),
    );
    expect(String(logs.error)).toMatch(/IDP_DRIFT/);
    expect(logs.lines.some((l) => l.includes('binding.drift'))).toBe(true);
  });

  it('limits managed keys per owner', async () => {
    const { api, pocket } = await owner({}, layout);
    pocket.s.users.get('u1')!.claims = Array.from({ length: 20 }, (_, i) =>
      claim(`passbook_k${i}`, 'x'),
    );
    await expect(
      api.setClaims({ subject: 'u1' }, { passbook_extra: { type: 'text', value: 'x' } }, ctx()),
    ).rejects.toThrow(/^IDP_REFUSED/);
  });

  it('keeps values out of the ledger, the tables and the logs', async () => {
    const { api, pocket } = await owner({}, layout);
    const logs = await captureLogs(async () => {
      await api.setClaims(
        { subject: 'u1' },
        { passbook_secret: { type: 'text', value: SECRET } },
        ctx(),
      );
      await api.claims({ subject: 'u1' });
      pocket.s.claimsTransform = (l) => [...l, claim('x', '1')];
      await api
        .setClaims(
          { subject: 'u1' },
          { passbook_secret: { type: 'text', value: `${SECRET}2` } },
          ctx({ ref: 'r2' }),
        )
        .catch(() => {});
    });
    for (const text of [...logs.lines, await dumpAll(), JSON.stringify(await ledger())])
      expect(text).not.toContain('VALUE-SECRET');
    const set = (await ledger()).find((r) => String(r.delta).includes('passbook_secret'));
    expect(set).toMatchObject({
      method: 'setClaims',
      role: 'passbook_secret',
      delta: expect.stringMatching(/^\+passbook_secret\(\d+\)$/),
    });
  });
});

describe('group claims', () => {
  it('writes role and custom group claims through the group routes', async () => {
    const { api, pocket } = setup();
    await api.createGroup('agency_a', 'Agency A', ctx({ ref: 'mk' }));
    await api.setClaims(
      { group: 'g:agency_a' },
      { passbook_org: { type: 'text', value: 'a' } },
      ctx({ ref: 'c1' }),
    );
    await api.setClaims(
      { group: 'developer' },
      { passbook_kind: { type: 'text', value: 'dev' } },
      ctx({ ref: 'c2' }),
    );
    expect(pocket.writes().filter((w) => w.path.includes('/custom-claims/'))).toMatchObject([
      { path: '/api/custom-claims/user-group/g-new-7' },
      { path: '/api/custom-claims/user-group/g-dev' },
    ]);
    expect((await api.claims({ group: 'g:agency_a' })).claims).toEqual({
      passbook_org: { type: 'text', value: 'a' },
    });
  });

  it('blocks a renamed group and an unmanaged one', async () => {
    const { api, pocket } = setup();
    await api.createGroup('agency_a', 'Agency A', ctx({ ref: 'mk' }));
    await expect(
      api.setClaims({ group: 'g:nope' }, { passbook_a: { type: 'text', value: 'x' } }, ctx()),
    ).rejects.toThrow(/^IDP_REFUSED/);
    pocket.s.groupNames['g-new-7'] = 'renamed';
    pocket.s.seen.length = 0;
    await expect(api.claims({ group: 'g:agency_a' })).rejects.toThrow(/^IDP_CONFLICT/);
    void seedGrant;
  });
});
