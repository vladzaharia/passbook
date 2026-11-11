import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { runOne } from '../../../test/helpers/index.ts';
import { grant, grantedBatch, prepareGrantForTest } from './authority.ts';
import { exactlyOne, rawCheck, rowIs } from './authority-checks.ts';
import type { AuthorityError } from './authority-error.ts';
import { coalesceTo, gt, inList, isNotNull, jsonSet, lt, maxNow } from './authority-expr.ts';
import { authorityPredicate, tenantFilter } from './authority-read.ts';
import { GUARDED_TABLES } from './authority-tables.ts';
import { setupGrant } from './authority-test-fixtures.ts';
import { all, first, run } from './db.ts';
import type { AppError } from './errors.ts';
import { sha256Hex } from './ids.ts';

const db = env.DB;

const code = (fn: () => unknown): string | null => {
  try {
    fn();
  } catch (e) {
    return (e as AuthorityError).code;
  }
  return null;
};
const count = async (sql: string, params: (string | number)[] = []) =>
  (await first<{ n: number }>(db, sql, params))?.n ?? 0;
const refused = async (promise: Promise<unknown>) =>
  (await promise.then(
    () => null,
    (e: unknown) => e,
  )) as AppError;

describe('B1: joined reaches a child only through a declared edge', () => {
  it('refuses a set that re-parents the child, and a parent key in where of another edge', async () => {
    const { route, member } = await setupGrant('b1-reparent');
    const g = grant(route, { purpose: 'org_mode.scan.update', principal: member() });
    expect(
      code(() =>
        g.joined('scan_event_templates', {
          set: { event_id: 'other' },
          where: { template_id: 't' },
        }),
      ),
    ).toBe('GRANT_SCOPE_OVERRIDE');
    expect(
      code(() =>
        g.joined('bundle_passes', {
          set: { bundle_id: 'x' },
          where: { pass_id: 'p' },
          via: 'pass_id',
        }),
      ),
    ).toBe('GRANT_SCOPE_OVERRIDE');
  });

  it('refuses joined on a table that carries its own org, and on a platform-only table', async () => {
    const { route, member } = await setupGrant('b1-orgbearing');
    const g = grant(route, { purpose: 'org_mode.scan.update', principal: member() });
    for (const table of ['passes', 'connections', 'scan_events', 'users', 'sessions'])
      expect(
        code(() => g.joined(table, { where: { id: 'x' }, delete: true })),
        table,
      ).toBe('GRANT_NO_EDGE');
  });

  it('refuses an edge the table does not declare', async () => {
    const { route, member } = await setupGrant('b1-via');
    const g = grant(route, { purpose: 'org_mode.scan.update', principal: member() });
    expect(
      code(() =>
        g.joined('scan_event_templates', { via: 'template_id', where: { a: 1 }, delete: true }),
      ),
    ).toBe('GRANT_NO_EDGE');
  });

  it('every declared edge is a real foreign key to a parent that carries the org', async () => {
    for (const [table, t] of Object.entries(GUARDED_TABLES)) {
      if (t.org !== null) {
        expect(t.edges, table).toBeUndefined();
        continue;
      }
      if (t.platform) continue;
      expect(t.edges?.length, table).toBeGreaterThan(0);
      const fks = await all<{ from: string; table: string; to: string }>(
        db,
        `SELECT "from", "table", "to" FROM pragma_foreign_key_list('${table}')`,
      );
      for (const e of t.edges ?? []) {
        expect(fks, `${table}.${e.column}`).toContainEqual({
          from: e.column,
          table: e.parent,
          to: e.key,
        });
        expect(GUARDED_TABLES[e.parent]?.org, e.parent).not.toBeNull();
      }
    }
  });

  it('a joined delete reaches a child under a parent in the tenant and not another tenant', async () => {
    const { s, route, member } = await setupGrant('b1-delete');
    const other = await setupGrant('b1-delete-other');
    const tpl = s.template.resolved.id;
    for (const ev of [s.event.id, other.s.event.id])
      await run(db, 'INSERT INTO scan_event_templates (event_id, template_id) VALUES (?, ?)', [
        ev,
        tpl,
      ]);
    const g = grant(route, { purpose: 'org_mode.scan.update', principal: member() });
    g.joined('scan_event_templates', {
      where: { template_id: tpl },
      delete: true,
      returning: ['event_id'],
    });
    const [r] = await g.commit();
    expect(r?.results).toEqual([{ event_id: s.event.id }]);
    expect(
      await count('SELECT count(*) AS n FROM scan_event_templates WHERE event_id = ?', [
        other.s.event.id,
      ]),
    ).toBe(1);
  });
});

describe('B2: the tenant column of the table is owned by the grant', () => {
  it('settings.scope cannot be set, inserted, upserted, filtered or checked', async () => {
    const { route, member } = await setupGrant('b2-settings');
    const g = grant(route, {
      purpose: 'org.settings.update',
      principal: member({ mode: undefined }),
    });
    const victim = 'org:someone-else';
    expect(code(() => g.update('settings', { set: { scope: victim }, where: { key: 'k' } }))).toBe(
      'GRANT_SCOPE_OVERRIDE',
    );
    expect(code(() => g.update('settings', { inc: ['scope'], where: { key: 'k' } }))).toBe(
      'GRANT_SCOPE_OVERRIDE',
    );
    expect(
      code(() => g.update('settings', { set: { value: '1' }, where: { scope: victim } })),
    ).toBe('GRANT_SCOPE_OVERRIDE');
    expect(
      code(() =>
        g.insertSelect('settings', ['scope', 'key', 'value', 'updated_at'], [victim, 'k', '1', 1]),
      ),
    ).toBe('GRANT_SCOPE_OVERRIDE');
    expect(
      code(() =>
        g.upsert('settings', ['scope', 'key', 'value', 'updated_at'], [victim, 'k', '1', 1], {
          update: ['value'],
        }),
      ),
    ).toBe('GRANT_SCOPE_OVERRIDE');
    expect(
      code(() =>
        g.upsert('settings', ['key', 'value', 'updated_at'], ['k', '1', 1], { update: ['key'] }),
      ),
    ).toBe('GRANT_SCOPE_OVERRIDE');
    // A check cannot name the owned column either.
    const check = rowIs('settings', 'x', { scope: victim });
    expect(() =>
      grant(route, {
        purpose: 'org.settings.update',
        principal: member({ mode: undefined }),
        checks: [check],
      }),
    ).toThrow(/grant supplies it/);
  });

  it('the org row id is owned too: an org grant cannot rename or re-id the org', async () => {
    const { route, member } = await setupGrant('b2-orgs');
    const g = grant(route, { purpose: 'org.org.update', principal: member({ mode: undefined }) });
    expect(code(() => g.update('orgs', { set: { id: 'x' }, where: {} }))).toBe(
      'GRANT_SCOPE_OVERRIDE',
    );
    expect(code(() => g.update('orgs', { set: { name: 'x' }, where: { id: 'x' } }))).toBe(
      'GRANT_SCOPE_OVERRIDE',
    );
    expect(code(() => g.update('orgs', { set: { name: 'x' }, where: {} }))).toBeNull();
  });

  it('an org grant updates its own settings row and nobody else', async () => {
    const { s, route, member } = await setupGrant('b2-ok');
    const other = await setupGrant('b2-ok-other');
    for (const o of [s.org.id, other.s.org.id])
      await run(
        db,
        "INSERT INTO settings (scope, key, value, updated_at) VALUES (?, 'k', '0', 1)",
        [`org:${o}`],
      );
    const g = grant(route, {
      purpose: 'org.settings.update',
      principal: member({ mode: undefined }),
    });
    g.update('settings', { set: { value: '7' }, where: { key: 'k' }, returning: ['scope'] });
    const [r] = await g.commit();
    expect(r?.results).toEqual([{ scope: `org:${s.org.id}` }]);
    expect(
      (
        await first<{ value: string }>(db, 'SELECT value FROM settings WHERE scope = ?', [
          `org:${other.s.org.id}`,
        ])
      )?.value,
    ).toBe('0');
  });
});

describe('B3: what the next packages need', () => {
  it('insertJoined writes an org-less child through its declared parent', async () => {
    const { s, route, member } = await setupGrant('b3-joined');
    const g = grant(route, { purpose: 'org_mode.scan.update', principal: member() });
    g.insertJoined('scan_event_templates', {
      parents: { event_id: s.event.id },
      columns: ['template_id'],
      values: [s.template.resolved.id],
      returning: ['event_id'],
    });
    const [r] = await g.commit();
    expect(r?.results).toEqual([{ event_id: s.event.id }]);
  });

  it('insertJoined under another tenant inserts nothing, and a wrong parent set is refused', async () => {
    const { s, route, member } = await setupGrant('b3-foreign');
    const other = await setupGrant('b3-foreign-other');
    const g = grant(route, { purpose: 'org_mode.scan.update', principal: member() });
    g.insertJoined('scan_event_templates', {
      parents: { event_id: other.s.event.id },
      columns: ['template_id'],
      values: [s.template.resolved.id],
      returning: ['event_id'],
    });
    const [r] = await g.commit();
    expect(r?.results).toEqual([]);
    expect(
      await count('SELECT count(*) AS n FROM scan_event_templates WHERE event_id = ?', [
        other.s.event.id,
      ]),
    ).toBe(0);
    const h = grant(route, { purpose: 'org_mode.scan.update', principal: member() });
    const base = { columns: ['template_id'], values: ['t'] };
    expect(code(() => h.insertJoined('scan_event_templates', { ...base, parents: {} }))).toBe(
      'GRANT_NO_EDGE',
    );
    expect(
      code(() =>
        h.insertJoined('scan_event_templates', {
          ...base,
          parents: { event_id: 'e', pass_id: 'p' },
        }),
      ),
    ).toBe('GRANT_NO_EDGE');
    expect(
      code(() =>
        h.insertJoined('scan_event_templates', {
          columns: ['event_id'],
          values: ['e'],
          parents: { event_id: 'e' },
        }),
      ),
    ).toBe('GRANT_SCOPE_OVERRIDE');
    expect(code(() => h.insertJoined('passes', { ...base, parents: { id: 'e' } }))).toBe(
      'GRANT_NO_EDGE',
    );
    expect(code(() => h.insertSelect('scan_event_templates', ['event_id'], ['e']))).toBe(
      'GRANT_NO_EDGE',
    );
  });

  it('a child with two parents needs both in the tenant', async () => {
    const { s, route, member } = await setupGrant('b3-two');
    const other = await setupGrant('b3-two-other');
    const bundle = async (orgId: string) => {
      const id = s.f.ids.id();
      await run(
        db,
        "INSERT INTO bundles (id, org_id, mode, name, token, created_at) VALUES (?, ?, 'live', 'b', ?, 1)",
        [id, orgId, s.f.ids.token()],
      );
      return id;
    };
    const mine = await bundle(s.org.id);
    const g = grant(route, { purpose: 'org_mode.bundle.edit', principal: member() });
    const add = (pass: string, bundleId: string) =>
      g.insertJoined('bundle_passes', {
        parents: { bundle_id: bundleId, pass_id: pass },
        columns: ['position'],
        values: [0],
        returning: ['pass_id'],
      });
    add(s.pass.id, mine);
    add(other.s.pass.id, mine);
    const [ok, foreign] = await g.commit();
    expect(ok?.results).toEqual([{ pass_id: s.pass.id }]);
    expect(foreign?.results).toEqual([]);
  });

  it('platform grants update users.status and sessions.revoked_at; nothing else, and no tenant grant', async () => {
    const { s, route } = await setupGrant('b3-platform');
    const principal = {
      kind: 'platform',
      userId: s.admin.id,
      sessionIdHash: await sha256Hex(s.adminSession.cookieValue),
    } as const;
    const g = grant(route, { purpose: 'platform.user.disable', principal });
    g.update('users', {
      set: { status: 'disabled' },
      where: { id: s.user.id },
      require: 'one',
      returning: ['id'],
    });
    g.update('sessions', { set: { revoked_at: 5 }, where: { user_id: s.user.id } });
    const [u] = await g.commit();
    expect(u?.results).toEqual([{ id: s.user.id }]);
    expect(
      (await first<{ status: string }>(db, 'SELECT status FROM users WHERE id = ?', [s.user.id]))
        ?.status,
    ).toBe('disabled');
    expect(
      await count('SELECT count(*) AS n FROM sessions WHERE user_id = ? AND revoked_at IS NULL', [
        s.user.id,
      ]),
    ).toBe(0);
    const h = grant(route, { purpose: 'platform.user.disable', principal });
    expect(code(() => h.update('users', { set: { primary_email: 'x' }, where: { id: 'u' } }))).toBe(
      'GRANT_SCOPE_OVERRIDE',
    );
    expect(
      code(() => h.update('sessions', { set: { roles: '[]' }, where: { user_id: 'u' } })),
    ).toBe('GRANT_SCOPE_OVERRIDE');
    expect(code(() => h.delete('users', { where: { id: 'u' } }))).toBe('GRANT_SCOPE_OVERRIDE');
    expect(code(() => h.insertSelect('users', ['name'], ['x']))).toBe('GRANT_NO_EDGE');
    const member = grant(route, {
      purpose: 'org.org.update',
      principal: {
        kind: 'membership',
        membershipId: s.membershipId,
        via: 'deferred',
        userAccessRevision: 1,
        allowRequestContext: true,
        orgAccessRevision: 1,
      },
    });
    expect(
      code(() => member.update('users', { set: { status: 'disabled' }, where: { id: 'u' } })),
    ).toBe('GRANT_SCOPE_OVERRIDE');
  });

  it('upsert inserts, then updates the same settings row at the fixed (scope, key) target', async () => {
    const { s, route, member } = await setupGrant('b3-upsert');
    const other = await setupGrant('b3-upsert-other');
    await run(db, "INSERT INTO settings (scope, key, value, updated_at) VALUES (?, 'k', '0', 1)", [
      `org:${other.s.org.id}`,
    ]);
    const save = async (value: string, at: number) => {
      const g = grant(route, {
        purpose: 'org.settings.update',
        principal: member({ mode: undefined }),
      });
      g.upsert('settings', ['key', 'value', 'updated_by', 'updated_at'], ['k', value, null, at], {
        update: ['value', 'updated_at'],
      });
      await g.commit();
    };
    await save('1', 5);
    await save('2', 6);
    const rows = await all<{ scope: string; value: string; updated_at: number }>(
      db,
      'SELECT scope, value, updated_at FROM settings WHERE key = ? AND scope IN (?, ?)',
      ['k', `org:${s.org.id}`, `org:${other.s.org.id}`],
    );
    expect(rows).toHaveLength(2);
    expect(rows).toContainEqual({ scope: `org:${s.org.id}`, value: '2', updated_at: 6 });
    expect(rows).toContainEqual({ scope: `org:${other.s.org.id}`, value: '0', updated_at: 1 });
    const g = grant(route, {
      purpose: 'org.settings.update',
      principal: member({ mode: undefined }),
    });
    expect(code(() => g.upsert('passes', ['id'], ['x'], { update: ['id'] }))).toBe(
      'GRANT_BAD_PURPOSE',
    );
    expect(code(() => g.upsert('settings', ['key', 'value'], ['k', '1'], { update: [] }))).toBe(
      'GRANT_BAD_PURPOSE',
    );
    expect(code(() => g.upsert('settings', ['value'], ['1'], { update: ['value'] }))).toBe(
      'GRANT_BAD_PURPOSE',
    );
  });

  it('the vetted expressions: maxNow, jsonSet, coalesceTo, inList, gt, lt, isNotNull', async () => {
    const { s, route, member } = await setupGrant('b3-expr');
    await run(
      db,
      "INSERT INTO settings (scope, key, value, updated_at) VALUES (?, 'j', '{\"a\":1}', 10)",
      [`org:${s.org.id}`],
    );
    await run(db, "INSERT INTO settings (scope, key, value, updated_at) VALUES (?, 'k', '0', 3)", [
      `org:${s.org.id}`,
    ]);
    const g = grant(route, {
      purpose: 'org.settings.update',
      principal: member({ mode: undefined }),
    });
    g.update('settings', {
      set: { updated_at: maxNow(5), value: jsonSet('$.b', 'x') },
      where: { key: 'j', updated_at: gt(5) },
      returning: ['updated_at'],
    });
    g.update('settings', {
      set: { updated_at: maxNow(99) },
      where: { key: inList(['k', 'zz']), updated_at: lt(5) },
      returning: ['updated_at'],
    });
    g.update('settings', {
      set: { updated_by: coalesceTo('me') },
      where: { key: 'k', value: isNotNull() },
      returning: ['updated_by'],
    });
    const [a, b, c] = await g.commit();
    expect(a?.results).toEqual([{ updated_at: 11 }]);
    expect(b?.results).toEqual([{ updated_at: 99 }]);
    expect(c?.results).toEqual([{ updated_by: 'me' }]);
    expect(
      (
        await first<{ value: string }>(
          db,
          "SELECT value FROM settings WHERE key = 'j' AND scope = ?",
          [`org:${s.org.id}`],
        )
      )?.value,
    ).toBe('{"a":1,"b":"x"}');
    expect(code(() => jsonSet('$.a; DROP', 1))).toBe('GRANT_BAD_IDENTIFIER');
    expect(code(() => inList([]))).toBe('GRANT_BAD_PURPOSE');
  });
});

describe('M2: require one and returning', () => {
  it('require one aborts the batch when the target is missing or in another tenant', async () => {
    const { s, route, member } = await setupGrant('m2-require');
    const other = await setupGrant('m2-require-other');
    const mine = grant(route, { purpose: 'org_mode.pass.publish', principal: member() });
    mine.update('passes', {
      set: { display_title: 'ok' },
      where: { id: s.pass.id },
      require: 'one',
      returning: ['id'],
    });
    const [r] = await mine.commit();
    expect(r?.results).toEqual([{ id: s.pass.id }]);
    for (const id of ['missing', other.s.pass.id]) {
      const g = grant(route, { purpose: 'org_mode.pass.publish', principal: member() });
      g.update('passes', { set: { display_title: 'no' }, where: { id }, require: 'one' });
      expect((await refused(g.commit())).code).toBe('LINEAGE_CHANGED');
    }
    expect(
      (
        await first<{ t: string }>(db, 'SELECT display_title AS t FROM passes WHERE id = ?', [
          other.s.pass.id,
        ])
      )?.t,
    ).not.toBe('no');
  });

  it('require one on delete and joined; a write after a refused one does not run', async () => {
    const { s, route, member } = await setupGrant('m2-joined');
    const g = grant(route, { purpose: 'org_mode.scan.update', principal: member() });
    g.joined('scan_event_templates', {
      where: { template_id: 'nope' },
      delete: true,
      require: 'one',
    });
    g.update('passes', { set: { display_title: 'second' }, where: { id: s.pass.id } });
    expect((await refused(g.commit())).code).toBe('LINEAGE_CHANGED');
    expect(
      (
        await first<{ t: string }>(db, 'SELECT display_title AS t FROM passes WHERE id = ?', [
          s.pass.id,
        ])
      )?.t,
    ).not.toBe('second');
    await runOne(db, 'UPDATE passes SET status = status WHERE id = ?', [s.pass.id]);
  });

  it('returning counts rows where meta.changes counts trigger changes', async () => {
    const { s, route, member } = await setupGrant('m2-returning');
    const g = grant(route, { purpose: 'org_mode.pass.publish', principal: member() });
    g.update('passes', {
      set: { display_title: 'r' },
      where: { id: s.pass.id },
      returning: ['id'],
    });
    const [r] = await g.commit();
    expect(r?.results).toHaveLength(1);
    expect(r?.meta.changes).toBeGreaterThan(1);
    expect(
      code(() =>
        g.update('passes', { set: { a: 1 }, where: { id: 'x' }, returning: ['id; DROP'] }),
      ),
    ).toBe('GRANT_BAD_IDENTIFIER');
  });
});

describe('M3 to M6', () => {
  it('tenantFilter scopes a read to the actor org and mode', async () => {
    const { s, member } = await setupGrant('m3-filter');
    const other = await setupGrant('m3-filter-other');
    const p = authorityPredicate(member(), { scope: 'org_mode', now: s.f.clock.now() });
    const rows = await all<{ id: string }>(
      db,
      `WITH ${p.ctes} SELECT p.id FROM passes p WHERE EXISTS (SELECT 1 FROM actor_ok) AND ${tenantFilter('p', 'passes')} AND p.id IN (?, ?)`,
      [...p.params, s.pass.id, other.s.pass.id],
    );
    expect(rows).toEqual([{ id: s.pass.id }]);
    const unfiltered = await all(
      db,
      `WITH ${p.ctes} SELECT p.id FROM passes p WHERE EXISTS (SELECT 1 FROM actor_ok) AND p.id IN (?, ?)`,
      [...p.params, s.pass.id, other.s.pass.id],
    );
    expect(unfiltered).toHaveLength(2);
    expect(tenantFilter('x', 'settings', 'org')).toBe(
      "x.scope = 'org:' || (SELECT org_id FROM actor_ok)",
    );
    expect(tenantFilter('o', 'orgs', 'org')).toBe('o.id = (SELECT org_id FROM actor_ok)');
    expect(code(() => tenantFilter('x', 'users'))).toBe('GRANT_UNGUARDED_TABLE');
  });

  it('M4: grants in one batch must share their codes', async () => {
    const { route, member } = await setupGrant('m4-codes');
    const a = grant(route, {
      purpose: 'org_mode.pass.publish',
      principal: member(),
      codes: { stale: 'PASS_CHANGED' },
    });
    const b = grant(route, { purpose: 'org_mode.pass.publish', principal: member() });
    const c = grant(route, {
      purpose: 'org_mode.pass.publish',
      principal: member(),
      codes: { stale: 'PASS_CHANGED' },
    });
    expect((await refused(grantedBatch(db, [a, b]))).code).toBe('GRANT_BATCH_MIXED');
    await expect(grantedBatch(db, [a, c])).resolves.toHaveLength(2);
  });

  it('M5: prepare is not part of the Grant API', async () => {
    const { route, member } = await setupGrant('m5-prepare');
    const g = grant(route, { purpose: 'org_mode.pass.publish', principal: member() });
    expect((g as unknown as Record<string, unknown>).prepare).toBeUndefined();
    expect(prepareGrantForTest(g)).toHaveLength(2);
  });

  it('M6: a session principal is checked against its session; deferred work has none', async () => {
    const { s, route, member } = await setupGrant('m6-liveness');
    const idHash = await sha256Hex(s.session.cookieValue);
    await run(db, 'UPDATE sessions SET revoked_at = 1 WHERE id_hash = ?', [idHash]);
    const bySession = grant(route, {
      purpose: 'org_mode.pass.publish',
      principal: member({ sessionIdHash: idHash }),
    });
    expect((await refused(bySession.commit())).code).toBe('ACTOR_CHANGED');
    const deferred = grant(route, { purpose: 'org_mode.pass.publish', principal: member() });
    await expect(deferred.commit()).resolves.toBeDefined();
    // Types: a session principal must carry its session hash, a deferred one its captured revision.
    // @ts-expect-error missing sessionIdHash
    const noHash: Parameters<typeof grant>[1]['principal'] = {
      kind: 'membership',
      membershipId: 'm',
      via: 'session',
    };
    // @ts-expect-error missing orgAccessRevision
    const noRevision: Parameters<typeof grant>[1]['principal'] = {
      kind: 'membership',
      membershipId: 'm',
      via: 'deferred',
      userAccessRevision: 1,
      allowRequestContext: true,
    };
    expect([noHash, noRevision]).toHaveLength(2);
  });

  it('minor 7 to 10: raw checks, errors and lineage checks stay classified', async () => {
    const check = (sql: string) => () =>
      rawCheck('stale', sql).ok({ bind: () => '?', params: [] }, 'org');
    for (const sql of [
      't.org_id = ?',
      'EXISTS (SELECT 1 FROM passes WHERE "org_id" IN (?))',
      'mode LIKE ?',
      'x = ? OR scope = ?',
      '1 = 1; DELETE FROM passes',
      '1 = 1 -- x',
      'EXISTS (SELECT 1 FROM x) /* y */',
      'EXISTS (INSERT INTO t VALUES (1))',
    ])
      expect(check(sql), sql).toThrow(/read-only|quoted/);
    expect(check('a.org_id IS NOT NULL AND a.mode IS NOT NULL')).not.toThrow();
    expect(
      code(() => exactlyOne('not_guarded', {}).ok({ bind: () => '?', params: [] }, 'org')),
    ).toBe('GRANT_UNGUARDED_TABLE');
    expect(code(() => rowIs('users', 'u').ok({ bind: () => '?', params: [] }, 'org'))).toBe(
      'GRANT_UNGUARDED_TABLE',
    );
  });

  it('minor 8: epoch columns cannot be written by insert, upsert or set', async () => {
    const { route, member } = await setupGrant('minor8');
    const g = grant(route, { purpose: 'org_mode.scan.update', principal: member() });
    expect(code(() => g.insertSelect('passes', ['id', 'row_version'], ['x', 5]))).toBe(
      'GRANT_SCOPE_OVERRIDE',
    );
    expect(code(() => g.insertSelect('scanners', ['id', 'credential_epoch'], ['x', 5]))).toBe(
      'GRANT_SCOPE_OVERRIDE',
    );
    expect(
      code(() => g.update('scan_events', { set: { config_epoch: 5 }, where: { id: 'x' } })),
    ).toBe('GRANT_SCOPE_OVERRIDE');
    expect(code(() => g.update('scan_staff', { inc: ['auth_epoch'], where: { id: 'x' } }))).toBe(
      'GRANT_SCOPE_OVERRIDE',
    );
    // Until WP4 adds its trigger, connections.generation is still written by the app.
    expect(
      code(() => g.update('connections', { inc: ['generation'], where: { id: 'x' } })),
    ).toBeNull();
  });
});

describe('M8 and the 0052 amendments', () => {
  const insertGrant = (
    leak: string | null,
    id = 'm8-1',
    purpose = 'platform.org.status',
    scope = 'platform',
    mode: string | null = null,
  ) =>
    run(
      db,
      `INSERT INTO authority_grants (id, scope, org_id, mode, principal, purpose, created_at, leak_guard) VALUES (?, ?, NULL, ?, 'platform:x', ?, 1, ?)`,
      [id, scope, mode, purpose, leak],
    );

  it('leak_guard is mandatory and equals the id, so the sentinel foreign key cannot be skipped', async () => {
    await expect(insertGrant(null)).rejects.toThrow(/NOT NULL|constraint/i);
    await expect(insertGrant('other')).rejects.toThrow(/CHECK|constraint/i);
    await expect(insertGrant('m8-1')).rejects.toThrow();
    expect(await count("SELECT count(*) AS n FROM authority_grants WHERE id = 'm8-1'")).toBe(0);
  });

  it('connection purposes need org_mode and live: org.connection is refused', async () => {
    const s = await setupGrant('conn-check');
    const row = (scope: string, purpose: string, mode: string | null) =>
      run(
        db,
        `INSERT INTO authority_grants (id, scope, org_id, mode, principal, purpose, created_at, leak_guard) VALUES ('c-1', ?, ?, ?, 'membership:x', ?, 1, 'c-1')`,
        [scope, s.s.org.id, mode, purpose],
      );
    await expect(row('org', 'org.connection.sync', null)).rejects.toThrow(/CHECK|constraint/i);
    await expect(row('org_mode', 'org_mode.connection.sync', 'test')).rejects.toThrow(
      /CHECK|constraint/i,
    );
    await expect(row('org_mode', 'org_mode.x.connection.sync', 'test')).rejects.toThrow(
      /CHECK|constraint/i,
    );
  });

  it('minor 5: a deleted api key id cannot be issued again', async () => {
    const { s } = await setupGrant('minor5');
    const key = (id: string) =>
      run(
        db,
        `INSERT INTO api_keys (id, org_id, name, prefix, key_hash, scopes, mode, created_by, created_at) VALUES (?, ?, 'k', ?, ?, '[]', 'live', NULL, 1)`,
        [id, s.org.id, `p${id}`.slice(0, 12), `h${id}`],
      );
    await key('retired-1');
    await run(db, "DELETE FROM api_keys WHERE id = 'retired-1'");
    await expect(key('retired-1')).rejects.toThrow(/UNIQUE constraint failed: api_keys.id/);
    await expect(key('fresh-1')).resolves.toBeDefined();
  });
});
