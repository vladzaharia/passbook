import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { makeOrg } from '../../../test/helpers/index.ts';
import {
  ENTITLEMENT_KEYS,
  ENTITLEMENT_PRESETS,
  type EntitlementKey,
  type EntitlementPreset,
  entitlementJson,
  presetValues,
} from '../../shared/contracts/entitlements.ts';
import { PRESET_LABEL } from '../../shared/copy/entitlements.ts';
import { templateSyncGrant } from '../jobs/template-sync.ts';
import { grant } from './authority.ts';
import type { Check } from './authority-checks.ts';
import { platformPrincipal, refusal } from './authority-ext-fixtures.ts';
import { setupGrant } from './authority-test-fixtures.ts';
import { all, first, run } from './db.ts';
import {
  entitled,
  entitlementsOf,
  isEntitled,
  requireEntitled,
  withinLimit,
} from './entitlements.ts';

const db = env.DB;
const HOUR = 3_600_000;

async function setPreset(orgId: string, preset: string) {
  await run(db, 'UPDATE org_entitlements SET preset = ? WHERE org_id = ?', [preset, orgId]);
}
async function override(
  orgId: string,
  key: string,
  value: string,
  expiresAt: number | null = null,
) {
  await run(
    db,
    'INSERT OR REPLACE INTO org_entitlement_overrides (org_id, key, value, expires_at, updated_at) VALUES (?, ?, ?, ?, 1)',
    [orgId, key, value, expiresAt],
  );
}
const resolved = async (orgId: string, key: string) =>
  (
    await first<{ value: string }>(
      db,
      'SELECT value FROM org_entitlement_values WHERE org_id = ? AND key = ?',
      [orgId, key],
    )
  )?.value;

describe('storage and seed', () => {
  it('seeds every preset with exactly the registry keys and values', async () => {
    for (const preset of ENTITLEMENT_PRESETS) {
      const rows = await all<{ key: string; value: string }>(
        db,
        'SELECT key, value FROM entitlement_presets WHERE preset = ?',
        [preset],
      );
      const want = presetValues(preset);
      expect(rows.map((r) => r.key).sort(), preset).toEqual([...ENTITLEMENT_KEYS].sort());
      for (const r of rows)
        expect(r.value, `${preset} ${r.key}`).toBe(entitlementJson(want[r.key as EntitlementKey]));
    }
    const meta = await all<{ preset: string; label: string; is_plan: number }>(
      db,
      'SELECT preset, label, is_plan FROM entitlement_preset_meta',
    );
    expect(meta.map((m) => m.preset).sort()).toEqual([...ENTITLEMENT_PRESETS].sort());
    for (const m of meta) {
      expect(m.label, m.preset).toBe(PRESET_LABEL[m.preset as EntitlementPreset]);
      expect(m.is_plan, m.preset).toBe(m.preset === 'developer' ? 0 : 1);
    }
  });

  it('0204 keeps a small footer where the effective allowance is full, and nobody else', async () => {
    const migration = (
      env as unknown as { TEST_MIGRATIONS: { name: string; queries: string[] }[] }
    ).TEST_MIGRATIONS.find((m) => m.name === '0204_plans.sql');
    const keep = migration?.queries.filter(
      (q) => /org_entitlement(_overrides|s)\b/.test(q) && /Kept the small/.test(q),
    );
    expect(keep?.length).toBe(2);
    const orgs: [string, string, string][] = [
      ['pl-trial', 'trial', '{"mark":"small"}'],
      ['pl-full', 'trial', '{"mark":"full"}'],
      ['pl-std', 'standard', '{"mark":"small"}'],
      ['pl-unl', 'legacy', '{"mark":"small"}'],
      ['pl-exp', 'trial', '{"mark":"small"}'],
      ['pl-std-full', 'standard', '{"mark":"small"}'],
      ['pl-std-none', 'standard', '{"mark":"small"}'],
      ['pl-unl-full', 'legacy', '{"mark":"small"}'],
    ];
    for (const [id, preset, branding] of orgs) {
      await run(
        db,
        'INSERT INTO orgs (id, slug, name, branding, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)',
        [id, id, id, branding],
      );
      await run(db, 'INSERT INTO org_entitlements (org_id, preset, updated_at) VALUES (?, ?, 1)', [
        id,
        preset,
      ]);
    }
    // An expired override, a standing one that makes the footer full again, and one that allows none.
    for (const [id, value, expires] of [
      ['pl-exp', '"none"', 5],
      ['pl-std-full', '"full"', null],
      ['pl-std-none', '"none"', null],
      ['pl-unl-full', '"full"', null],
    ] as const)
      await run(
        db,
        "INSERT INTO org_entitlement_overrides (org_id, key, value, expires_at, updated_at) VALUES (?, 'brand.mark', ?, ?, 1)",
        [id, value, expires],
      );
    for (const q of keep ?? []) await run(db, q);
    const rows = await all<{ org_id: string; value: string; revision: number }>(
      db,
      `SELECT o.org_id, o.value, e.revision FROM org_entitlement_overrides o
       JOIN org_entitlements e ON e.org_id = o.org_id WHERE o.org_id LIKE 'pl-%' AND o.key = 'brand.mark'
       ORDER BY o.org_id`,
    );
    expect(rows).toEqual([
      { org_id: 'pl-exp', value: '"quiet"', revision: 2 },
      { org_id: 'pl-std-full', value: '"quiet"', revision: 2 },
      { org_id: 'pl-std-none', value: '"none"', revision: 1 },
      { org_id: 'pl-trial', value: '"quiet"', revision: 2 },
      // Unlimited is never written to, even with a standing `full` and a stored small footer.
      { org_id: 'pl-unl-full', value: '"full"', revision: 1 },
    ]);
    const expired = await first<{ expires_at: number | null }>(
      db,
      "SELECT expires_at FROM org_entitlement_overrides WHERE org_id = 'pl-exp' AND key = 'brand.mark'",
    );
    expect(expired?.expires_at).toBeNull();
  });

  it('every existing org gets a legacy row from the migration, and a row already there stays', async () => {
    const f = (await setupGrant('backfill')).s.f;
    const migration = (
      env as unknown as { TEST_MIGRATIONS: { name: string; queries: string[] }[] }
    ).TEST_MIGRATIONS.find((m) => m.name === '0134_entitlements.sql');
    const backfill = migration?.queries.find((q) => /INSERT INTO org_entitlements/.test(q));
    expect(backfill).toBeDefined();
    const ids = ['bf-1', 'bf-2'];
    for (const id of ids)
      await run(
        db,
        'INSERT INTO orgs (id, slug, name, created_at, updated_at) VALUES (?, ?, ?, 1, 1)',
        [id, id, id],
      );
    await run(
      db,
      "INSERT INTO org_entitlements (org_id, preset, updated_at) VALUES ('bf-2', 'trial', 1)",
    );
    await run(db, backfill as string);
    const rows = await all<{ org_id: string; preset: string }>(
      db,
      "SELECT org_id, preset FROM org_entitlements WHERE org_id IN ('bf-1', 'bf-2') ORDER BY org_id",
    );
    expect(rows).toEqual([
      { org_id: 'bf-1', preset: 'legacy' },
      { org_id: 'bf-2', preset: 'trial' },
    ]);
    const orphans = await first<{ n: number }>(
      db,
      'SELECT count(*) AS n FROM orgs o LEFT JOIN org_entitlements e ON e.org_id = o.id WHERE e.org_id IS NULL AND o.id LIKE ?',
      ['bf-%'],
    );
    expect(orphans?.n).toBe(0);
    // legacy resolves to the registry's legacy values: nothing changes for an existing org.
    const legacy = presetValues('legacy');
    const resolved = await all<{ key: string; value: string }>(
      db,
      "SELECT key, value FROM org_entitlement_values WHERE org_id = 'bf-1'",
    );
    expect(Object.fromEntries(resolved.map((r) => [r.key, r.value]))).toEqual(
      Object.fromEntries(ENTITLEMENT_KEYS.map((k) => [k, entitlementJson(legacy[k])])),
    );
    expect(f).toBeDefined();
  });

  it('keeps the row while the org exists, and removes it with the org', async () => {
    const { s } = await setupGrant('keep-row');
    await expect(
      run(db, 'DELETE FROM org_entitlements WHERE org_id = ?', [s.org.id]),
    ).rejects.toThrow(/keeps its entitlements row/);
    await expect(
      run(db, "UPDATE org_entitlements SET org_id = 'other' WHERE org_id = ?", [s.org.id]),
    ).rejects.toThrow(/fixed/);
    const f = s.f;
    const gone = await makeOrg(f);
    await override(gone.id, 'api', '"read"');
    await run(db, 'DELETE FROM orgs WHERE id = ?', [gone.id]);
    expect(
      await first(db, 'SELECT 1 AS x FROM org_entitlements WHERE org_id = ?', [gone.id]),
    ).toBeNull();
    expect(
      await first(db, 'SELECT 1 AS x FROM org_entitlement_overrides WHERE org_id = ?', [gone.id]),
    ).toBeNull();
  });

  it('refuses a preset or value that is not valid', async () => {
    const { s } = await setupGrant('bad-rows');
    await expect(
      run(
        db,
        "INSERT INTO org_entitlements (org_id, preset, updated_at) VALUES ('nobody', 'trial', 1)",
      ),
    ).rejects.toThrow(/FOREIGN KEY/);
    await expect(
      run(db, "UPDATE org_entitlements SET preset = 'ghost' WHERE org_id = ?", [s.org.id]),
    ).rejects.toThrow(/FOREIGN KEY/);
    await expect(override(s.org.id, 'api', 'not json')).rejects.toThrow(/CHECK/);
    // Stored text is canonical JSON, so SQL and JS read the same value.
    await expect(override(s.org.id, 'api', '"full" ')).rejects.toThrow(/CHECK/);
  });
});

describe('overrides and expiry', () => {
  it('an override beats the preset; an expired one does not; a future one does', async () => {
    const { s } = await setupGrant('override');
    await setPreset(s.org.id, 'trial');
    expect(await resolved(s.org.id, 'print')).toBe('0');
    await override(s.org.id, 'print', '1');
    expect(await resolved(s.org.id, 'print')).toBe('1');
    await override(s.org.id, 'print', '1', Date.now() - 1);
    expect(await resolved(s.org.id, 'print')).toBe('0');
    await override(s.org.id, 'print', '1', Date.now() + HOUR);
    expect(await resolved(s.org.id, 'print')).toBe('1');
    await override(s.org.id, 'members', 'null', Date.now() + HOUR);
    expect(await resolved(s.org.id, 'members')).toBe('null');
  });

  it('a grant denies once the override expires, with no write in between', async () => {
    const { s, route, member } = await setupGrant('override-grant');
    await setPreset(s.org.id, 'trial');
    const g = () =>
      refusal(
        grant(route, {
          purpose: 'org_mode.test.entitled',
          principal: member(),
          checks: [entitled('print')],
        }).commit(),
      );
    expect((await g())?.code).toBe('FEATURE_NOT_INCLUDED');
    await override(s.org.id, 'print', '1', Date.now() + 60_000);
    expect(await g()).toBeNull();
    await override(s.org.id, 'print', '1', Date.now() - 1);
    expect((await g())?.code).toBe('FEATURE_NOT_INCLUDED');
  });
});

describe('fail closed', () => {
  it('an org with no row is denied every check', async () => {
    const { s, route, member } = await setupGrant('no-row');
    // The keep-trigger refuses deleting the row while the org exists; drop it for this one scenario.
    const keep = await first<{ sql: string }>(
      db,
      "SELECT sql FROM sqlite_master WHERE name = 'org_entitlements_keep'",
    );
    await run(db, 'DROP TRIGGER org_entitlements_keep');
    try {
      await run(db, 'DELETE FROM org_entitlements WHERE org_id = ?', [s.org.id]);
      const go = (c: Check) =>
        refusal(
          grant(route, {
            purpose: 'org_mode.test.entitled',
            principal: member(),
            checks: [c],
          }).commit(),
        );
      expect((await go(entitled('print')))?.code).toBe('FEATURE_NOT_INCLUDED');
      expect((await go(entitled('api', 'read')))?.code).toBe('FEATURE_NOT_INCLUDED');
      expect((await go(entitled('connectors', 'csv-url')))?.code).toBe('FEATURE_NOT_INCLUDED');
      expect((await go(entitled('templates.stylesBlocked', 'coupon')))?.code).toBe(
        'FEATURE_NOT_INCLUDED',
      );
      expect((await go(entitled('connections')))?.code).toBe('FEATURE_NOT_INCLUDED');
      expect((await go(withinLimit('templates', 'SELECT 0 WHERE {org} IS NOT NULL')))?.code).toBe(
        'FEATURE_LIMIT_REACHED',
      );
      expect((await refusal(requireEntitled(route, s.org.id, 'print')))?.code).toBe(
        'FEATURE_NOT_INCLUDED',
      );
    } finally {
      await run(db, keep?.sql as string);
      await run(
        db,
        "INSERT INTO org_entitlements (org_id, preset, updated_at) VALUES (?, 'legacy', 1)",
        [s.org.id],
      );
    }
  });

  it('a key the preset lacks, and a malformed value, deny', async () => {
    const { s, route, member } = await setupGrant('missing-key');
    await run(
      db,
      "INSERT INTO entitlement_preset_meta (preset, label, updated_at) VALUES ('bare', 'Bare', 1)",
    );
    await run(
      db,
      "INSERT INTO entitlement_presets (preset, key, value) VALUES ('bare', 'webhooks', '\"yes\"'), ('bare', 'templates', '\"5\"'), ('bare', 'connections', '5.5'), ('bare', 'api', '\"huge\"'), ('bare', 'members', '3')",
    );
    await setPreset(s.org.id, 'bare');
    const go = (c: Check) =>
      refusal(
        grant(route, {
          purpose: 'org_mode.test.entitled',
          principal: member(),
          checks: [c],
        }).commit(),
      );
    expect((await go(entitled('print')))?.code).toBe('FEATURE_NOT_INCLUDED'); // not in the preset
    expect((await go(entitled('webhooks')))?.code).toBe('FEATURE_NOT_INCLUDED'); // "yes" is not 1
    expect((await go(entitled('api', 'read')))?.code).toBe('FEATURE_NOT_INCLUDED'); // not a level
    expect((await go(entitled('connections')))?.code).toBe('FEATURE_NOT_INCLUDED'); // not an integer
    expect((await go(withinLimit('templates', 'SELECT 0 WHERE {org} IS NOT NULL')))?.code).toBe(
      'FEATURE_LIMIT_REACHED',
    ); // "5"
    expect((await go(withinLimit('connections', 'SELECT 0 WHERE {org} IS NOT NULL')))?.code).toBe(
      'FEATURE_LIMIT_REACHED',
    ); // 5.5
    expect(await go(withinLimit('members', 'SELECT 0 WHERE {org} IS NOT NULL'))).toBeNull(); // 3 > 0
    expect((await go(withinLimit('api.keys', 'SELECT 0 WHERE {org} IS NOT NULL')))?.code).toBe(
      'FEATURE_LIMIT_REACHED',
    ); // missing
    const e = await entitlementsOf(route, s.org.id);
    expect(e.members).toBe(3);
    expect(e.webhooks).toBeUndefined();
    expect(isEntitled(e, 'webhooks')).toBe(false);
  });
});

describe('entitled', () => {
  const cases: [string, string, Check, boolean][] = [
    ['flag off', 'trial', entitled('print'), false],
    ['flag on', 'standard', entitled('print'), true],
    ['level below', 'standard', entitled('nfc', 'secure'), false],
    ['level at', 'standard', entitled('nfc', 'basic'), true],
    ['level above', 'legacy', entitled('nfc', 'basic'), true],
    ['level off', 'trial', entitled('nfc', 'basic'), false],
    ['allow-list star', 'standard', entitled('connectors', 'shopify/orders'), true],
    [
      'allow-list type wildcard',
      'starter',
      entitled('connectors', 'webhook-push/shopify-orders'),
      true,
    ],
    [
      'allow-list stub excludes webhook push',
      'trial',
      entitled('connectors', 'webhook-push/x'),
      false,
    ],
    ['allow-list exact', 'trial', entitled('connectors', 'csv-url'), true],
    ['allow-list miss', 'trial', entitled('connectors', 'square'), false],
    ['block-list hit', 'trial', entitled('templates.stylesBlocked', 'boardingPass'), false],
    ['block-list miss', 'trial', entitled('templates.stylesBlocked', 'coupon'), true],
    ['block-list empty', 'standard', entitled('templates.stylesBlocked', 'boardingPass'), true],
    ['limit above zero', 'trial', entitled('connections'), true],
    ['limit null', 'legacy', entitled('connections'), true],
    ['limit zero', 'trial', entitled('domains'), false],
    ['limit one', 'business', entitled('domains'), true],
  ];
  it.each(cases)('%s (%s)', async (_n, preset, check, ok) => {
    const { s, route, member } = await setupGrant(`entitled-${_n.replaceAll(' ', '-')}`);
    await setPreset(s.org.id, preset);
    const e = await refusal(
      grant(route, {
        purpose: 'org_mode.test.entitled',
        principal: member(),
        checks: [check],
      }).commit(),
    );
    expect(e === null).toBe(ok);
    if (!ok) expect(e?.code).toBe('FEATURE_NOT_INCLUDED');
    expect(e?.status ?? 200).toBe(ok ? 200 : 403);
  });

  it('a level or list check needs what it compares', () => {
    expect(() => entitled('nfc')).toThrow(/needs a level/);
    expect(() => entitled('nfc', 'huge')).toThrow(/needs a level/);
    expect(() => entitled('connectors')).toThrow(/needs an item/);
    expect(() => withinLimit('print', 'SELECT 0')).toThrow(/needs a limit/);
  });

  it('a platform grant has no org to ask', async () => {
    const { s, route } = await setupGrant('entitled-platform');
    const principal = await platformPrincipal(s);
    expect(() =>
      grant(route, { purpose: 'platform.test.entitled', principal, checks: [entitled('print')] }),
    ).toThrow(/needs a tenant/);
  });

  it('maps to the problem with a stable code, and a grant may rename it', async () => {
    const { s, route, member } = await setupGrant('entitled-codes');
    await setPreset(s.org.id, 'trial');
    const e = await refusal(
      grant(route, {
        purpose: 'org_mode.test.entitled',
        principal: member(),
        checks: [entitled('print')],
        codes: { entitlement: 'APPS_NOT_INCLUDED' },
      }).commit(),
    );
    expect(e?.code).toBe('APPS_NOT_INCLUDED');
    expect(e?.status).toBe(403);
  });
});

describe('withinLimit', () => {
  const COUNT = 'SELECT count(*) FROM connections cn WHERE cn.org_id = {org}';
  const add = (g: ReturnType<typeof grant>, id: string) =>
    g.insertSelect(
      'connections',
      ['id', 'connector_type', 'name', 'created_at', 'updated_at'],
      [id, 'x', id, 1, 1],
    );
  const create = (
    route: Parameters<typeof grant>[0],
    principal: Parameters<typeof grant>[1]['principal'],
    id: string,
  ) => {
    const g = grant(route, {
      purpose: 'org_mode.test.entitled',
      principal,
      checks: [withinLimit('connections', COUNT)],
    });
    add(g, id);
    return g.commit();
  };
  const count = async (orgId: string) =>
    (
      await first<{ n: number }>(db, 'SELECT count(*) AS n FROM connections WHERE org_id = ?', [
        orgId,
      ])
    )?.n;

  it('passes below the cap, refuses at it, and null has none', async () => {
    const { s, route, member } = await setupGrant('limit-basic');
    await override(s.org.id, 'connections', '2');
    // The seed row counts: one connection exists.
    expect(await count(s.org.id)).toBe(1);
    expect(await refusal(create(route, member(), 'c-n-1'))).toBeNull();
    const e = await refusal(create(route, member(), 'c-n'));
    expect(e?.code).toBe('FEATURE_LIMIT_REACHED');
    expect(e?.status).toBe(403);
    expect(await count(s.org.id)).toBe(2);
    await override(s.org.id, 'connections', 'null');
    expect(await refusal(create(route, member(), 'c-null'))).toBeNull();
    await override(s.org.id, 'connections', '0');
    expect((await refusal(create(route, member(), 'c-zero')))?.code).toBe('FEATURE_LIMIT_REACHED');
  });

  it('two creates at n-1 admit exactly one', async () => {
    const { s, route, member } = await setupGrant('limit-race');
    await override(s.org.id, 'connections', '4');
    for (const id of ['r-1', 'r-2'])
      await run(
        db,
        "INSERT INTO connections (id, org_id, connector_type, name, created_at, updated_at) VALUES (?, ?, 'x', ?, 1, 1)",
        [id, s.org.id, id],
      );
    expect(await count(s.org.id)).toBe(3);
    const results = await Promise.all(
      ['a', 'b', 'c', 'd', 'e'].map((id) => refusal(create(route, member(), `race-${id}`))),
    );
    expect(results.filter((r) => r === null)).toHaveLength(1);
    expect(results.filter((r) => r?.code === 'FEATURE_LIMIT_REACHED')).toHaveLength(4);
    expect(await count(s.org.id)).toBe(4);
  });

  it('counts only the actor org: another org at its cap does not block this one', async () => {
    const a = await setupGrant('limit-iso-a');
    const b = await setupGrant('limit-iso-b');
    await override(a.s.org.id, 'connections', '1');
    await override(b.s.org.id, 'connections', 'null');
    for (let i = 0; i < 3; i++)
      await run(
        db,
        "INSERT INTO connections (id, org_id, connector_type, name, created_at, updated_at) VALUES (?, ?, 'x', ?, 1, 1)",
        [`iso-${i}`, b.s.org.id, `iso-${i}`],
      );
    expect((await refusal(create(a.route, a.member(), 'iso-a')))?.code).toBe(
      'FEATURE_LIMIT_REACHED',
    );
    expect(await refusal(create(b.route, b.member(), 'iso-b'))).toBeNull();
  });

  it('a lowered limit keeps what exists and refuses more', async () => {
    const { s, route, member } = await setupGrant('limit-lowered');
    await override(s.org.id, 'connections', 'null');
    await refusal(create(route, member(), 'low-1'));
    await override(s.org.id, 'connections', '1');
    expect(await count(s.org.id)).toBe(2);
    expect((await refusal(create(route, member(), 'low-2')))?.code).toBe('FEATURE_LIMIT_REACHED');
    expect(await count(s.org.id)).toBe(2);
  });

  it('binds the count params before the key', async () => {
    const { s, route, member } = await setupGrant('limit-binds');
    await override(s.org.id, 'connections', '2');
    const g = grant(route, {
      purpose: 'org_mode.test.entitled',
      principal: member(),
      checks: [
        withinLimit(
          'connections',
          'SELECT count(*) FROM connections cn WHERE cn.org_id = {org} AND cn.connector_type = ?',
          ['x'],
        ),
      ],
    });
    expect(await refusal(g.commit())).toBeNull();
    const none = grant(route, {
      purpose: 'org_mode.test.entitled',
      principal: member(),
      checks: [
        withinLimit(
          'connections',
          'SELECT count(*) FROM connections cn WHERE cn.org_id = {org} AND cn.connector_type = ?',
          ['y'],
        ),
      ],
    });
    expect(await refusal(none.commit())).toBeNull();
    await override(s.org.id, 'connections', '1');
    const full = grant(route, {
      purpose: 'org_mode.test.entitled',
      principal: member(),
      checks: [
        withinLimit(
          'connections',
          'SELECT count(*) FROM connections cn WHERE cn.org_id = {org} AND cn.connector_type = ?',
          ['x'],
        ),
      ],
    });
    expect((await refusal(full.commit()))?.code).toBe('FEATURE_LIMIT_REACHED');
    expect(s.org.id).toBeDefined();
  });
});

describe('an org cannot write its own entitlements', () => {
  const tables = ['org_entitlements', 'org_entitlement_overrides'];

  it('refuses every org and org_mode purpose, by every builder', async () => {
    const { s, route, member } = await setupGrant('org-write');
    const org = () => grant(route, { purpose: 'org.test.write', principal: member() });
    const mode = () => grant(route, { purpose: 'org_mode.test.write', principal: member() });
    for (const make of [org, mode]) {
      for (const table of tables) {
        const code = (fn: () => unknown) => {
          try {
            fn();
          } catch (e) {
            return (e as { code: string }).code;
          }
          return null;
        };
        expect(
          code(() => make().update(table, { set: { updated_at: 1 }, where: {} })),
          table,
        ).toBe('GRANT_TABLE_NOT_ALLOWED');
        expect(
          code(() => make().insertSelect(table, ['preset', 'updated_at'], ['legacy', 1])),
          table,
        ).toBe('GRANT_TABLE_NOT_ALLOWED');
        expect(
          code(() => make().delete(table, { where: {} })),
          table,
        ).toBe('GRANT_TABLE_NOT_ALLOWED');
      }
      expect(() =>
        make().upsert(
          'org_entitlement_overrides',
          ['key', 'value', 'updated_at'],
          ['api', '"off"', 1],
          { update: ['value'] },
        ),
      ).toThrow(/written only by/);
    }
    // Nothing moved.
    expect(
      (
        await first<{ preset: string }>(
          db,
          'SELECT preset FROM org_entitlements WHERE org_id = ?',
          [s.org.id],
        )
      )?.preset,
    ).toBe('legacy');
  });

  it('also refuses an api key and the preset tables', async () => {
    const { s, route } = await setupGrant('org-write-key');
    const keyPrincipal = { kind: 'api_key', keyId: s.key.id, mode: 'live' } as never;
    const g = grant(route, { purpose: 'org_mode.test.write', principal: keyPrincipal });
    expect(() => g.update('org_entitlements', { set: { preset: 'legacy' }, where: {} })).toThrow(
      /written only by/,
    );
    const m = grant(route, { purpose: 'org_mode.test.write', principal: keyPrincipal });
    expect(() => m.update('entitlement_presets', { set: { value: '1' }, where: {} })).toThrow(
      /written only by|platform/,
    );
  });

  it('allows only the platform purposes of the design, and not for another purpose', async () => {
    const { s, route } = await setupGrant('platform-write');
    const principal = await platformPrincipal(s);
    const ok = grant(route, {
      purpose: 'platform.org.entitlements_set',
      principal,
      target: s.org.id,
    });
    ok.update('org_entitlements', {
      set: { preset: 'trial', updated_at: 5 },
      where: { org_id: s.org.id },
      returning: ['org_id'],
    });
    const [res] = await ok.commit();
    expect(res?.results).toHaveLength(1);
    expect(
      (
        await first<{ preset: string }>(
          db,
          'SELECT preset FROM org_entitlements WHERE org_id = ?',
          [s.org.id],
        )
      )?.preset,
    ).toBe('trial');
    const wrong = grant(route, { purpose: 'platform.org.status', principal, target: s.org.id });
    expect(() =>
      wrong.update('org_entitlements', { set: { updated_at: 6 }, where: { org_id: s.org.id } }),
    ).toThrow(/written only by/);
    const preset = grant(route, { purpose: 'platform.org.entitlements_set', principal });
    expect(() => preset.update('entitlement_presets', { set: { value: '1' }, where: {} })).toThrow(
      /written only by/,
    );
  });
});

describe('baked-template sync writes entitlements by insert only', () => {
  // authority-tables INSERT_ONLY_PURPOSES (#272): the sync creates the platform org with its legacy row and
  // must never change one.
  it('refuses update, delete and upsert; allows the insert', async () => {
    const { route } = await setupGrant('sync-insert-only');
    const g = () => templateSyncGrant(route, []);
    expect(() =>
      g().update('org_entitlements', { set: { preset: 'trial' }, where: { org_id: 'x' } }),
    ).toThrow(/only inserts/);
    expect(() => g().delete('org_entitlements', { where: { org_id: 'x' } })).toThrow(
      /only inserts/,
    );
    expect(() =>
      g().upsert('org_entitlements', ['org_id', 'preset', 'updated_at'], ['x', 'trial', 1], {
        update: ['preset'],
      }),
    ).toThrow(/only inserts|written only/);
    expect(() =>
      g().insertSelect('org_entitlements', ['org_id', 'preset', 'updated_at'], ['x', 'legacy', 1]),
    ).not.toThrow();
  });
});

describe('org create writes entitlements by insert only', () => {
  it('refuses update, delete and upsert of org_entitlements, so create cannot change a preset', async () => {
    const { s, route } = await setupGrant('create-insert-only');
    const principal = await platformPrincipal(s);
    const g = () => grant(route, { purpose: 'platform.org.create', principal });
    expect(() =>
      g().update('org_entitlements', { set: { preset: 'trial' }, where: { org_id: 'x' } }),
    ).toThrow(/only inserts/);
    expect(() => g().delete('org_entitlements', { where: { org_id: 'x' } })).toThrow(
      /only inserts/,
    );
    expect(() =>
      g().insertSelect('org_entitlements', ['org_id', 'preset', 'updated_at'], ['x', 'legacy', 1]),
    ).not.toThrow();
  });
});

describe('entitlementsOf per request (review L2)', () => {
  it('reads an org once per request id, and every time without one', async () => {
    const org = await makeOrg({
      env,
      ids: { id: () => crypto.randomUUID() },
      clock: { now: () => Date.now() },
    } as never);
    const ctx = (requestId: string | null) => ({ env, requestId, log: { error() {} } }) as never;
    const seen = ctx('req-memo-1');
    expect((await entitlementsOf(seen, org.id)).print).toBe(1);
    await setPreset(org.id, 'trial');
    // The same request keeps its first answer; another request and a job read the new plan.
    expect((await entitlementsOf(seen, org.id)).print).toBe(1);
    expect((await entitlementsOf(ctx('req-memo-2'), org.id)).print).toBe(0);
    expect((await entitlementsOf(ctx(null), org.id)).print).toBe(0);
    await setPreset(org.id, 'legacy');
    expect((await entitlementsOf(ctx(null), org.id)).print).toBe(1);
  });
});
