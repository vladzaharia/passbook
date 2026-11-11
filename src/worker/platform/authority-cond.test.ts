import { describe, expect, it } from 'vitest';
import { grant } from './authority.ts';
import { exactlyOne } from './authority-checks.ts';
import { condCheck, exists, not, notExists, tenantCheck, tenantSql } from './authority-cond.ts';
import { gte, inList, isNotNull, lte, ne, orNull } from './authority-expr.ts';
import {
  codeOf,
  db,
  explains,
  gateRows,
  insertGate,
  platformPrincipal,
  refusal,
  resultRows,
} from './authority-ext-fixtures.ts';
import { builtOf } from './authority-granted.ts';
import { setupGrant } from './authority-test-fixtures.ts';
import { run } from './db.ts';

describe('A: gte, lte, ne, orNull', () => {
  it('render text and bind order; orNull wraps only comparisons', async () => {
    const { route, member } = await setupGrant('cond-a-text');
    const g = grant(route, { purpose: 'org_mode.test.cond', principal: member() });
    const st = g.update('scan_gates', {
      set: { state: 'out' },
      where: {
        last_at: gte(5),
        count: orNull(lte(3)),
        last_scan_id: ne('a'),
        prev_scan_id: orNull(ne('b')),
      },
    });
    const { sql, params } = builtOf(st);
    expect(sql).toContain(
      'last_at >= ? AND (count IS NULL OR count <= ?) AND last_scan_id IS NOT ? AND (prev_scan_id IS NULL OR prev_scan_id IS NOT ?)',
    );
    expect(params.slice(0, 5)).toEqual(['out', 5, 3, 'a', 'b']);
    expect(codeOf(() => orNull(inList([1])))).toBe('GRANT_BAD_PURPOSE');
    expect(codeOf(() => orNull(isNotNull()))).toBe('GRANT_BAD_PURPOSE');
    expect(codeOf(() => orNull(orNull(lte(1))))).toBe('GRANT_BAD_PURPOSE');
  });

  it('ne(null) matches non-null rows; gte and lte bound ranges; orNull(ne(x)) matches NULL and other values (25)', async () => {
    const { s, route, member } = await setupGrant('cond-a-run');
    const pid = s.pass.id;
    await insertGate({ passId: pid, orgId: s.org.id, action: 'a1', lastAt: 10, prevScan: null });
    await insertGate({ passId: pid, orgId: s.org.id, action: 'a2', lastAt: 20, prevScan: 'p1' });
    await insertGate({ passId: pid, orgId: s.org.id, action: 'a3', lastAt: 30, prevScan: 'p2' });
    const touched = async (where: Record<string, unknown>) => {
      const g = grant(route, { purpose: 'org_mode.test.cond', principal: member() });
      const st = g.update('scan_gates', {
        inc: ['count'],
        where: { pass_id: pid, ...where } as never,
        returning: ['action_id'],
      });
      const res = await g.commit();
      return resultRows<{ action_id: string }>(res, g.indexOf(st))
        .map((r) => r.action_id)
        .sort();
    };
    expect(await touched({ prev_scan_id: ne(null) })).toEqual(['a2', 'a3']);
    expect(await touched({ prev_scan_id: orNull(ne('p1')) })).toEqual(['a1', 'a3']);
    expect(await touched({ last_at: gte(20) })).toEqual(['a2', 'a3']);
    expect(await touched({ last_at: lte(20) })).toEqual(['a1', 'a2']);
    expect(await touched({ last_at: orNull(gte(25)) })).toEqual(['a3']);
  });
});

describe('B: exists, notExists and tenant scoping', () => {
  const sees = async (g: ReturnType<typeof grant>, cond: ReturnType<typeof exists>) => {
    g.assert('stale', [cond]);
    return (await refusal(g.commit())) === null;
  };

  it('does not see a same-key row of another org or, under org_mode, another mode (2)', async () => {
    const a = await setupGrant('cond-b-a');
    const b = await setupGrant('cond-b-b');
    await insertGate({ passId: b.s.pass.id, orgId: b.s.org.id });
    await insertGate({ passId: a.s.pass.id, orgId: a.s.org.id, mode: 'test' });
    const live = () => grant(a.route, { purpose: 'org_mode.test.cond', principal: a.member() });
    const orgWide = () =>
      grant(a.route, { purpose: 'org.test.cond', principal: a.member({ mode: undefined }) });
    expect(await sees(live(), exists('scan_gates', { pass_id: b.s.pass.id }))).toBe(false);
    expect(await sees(live(), exists('scan_gates', { pass_id: a.s.pass.id }))).toBe(false);
    expect(await sees(orgWide(), exists('scan_gates', { pass_id: a.s.pass.id }))).toBe(true);
    expect(await sees(orgWide(), exists('scan_gates', { pass_id: b.s.pass.id }))).toBe(false);
    expect(await sees(live(), notExists('scan_gates', { pass_id: a.s.pass.id }))).toBe(true);
    expect(await sees(live(), not(exists('scan_gates', { pass_id: b.s.pass.id })))).toBe(true);
  });

  it('refuses owned columns, org-less tables and empty where; a platform grant adds no tenant term', async () => {
    const { s, route, member } = await setupGrant('cond-b-rules');
    const g = grant(route, { purpose: 'org_mode.test.cond', principal: member() });
    expect(codeOf(() => g.assert('stale', [exists('scan_gates', { org_id: 'x' })]))).toBe(
      'GRANT_SCOPE_OVERRIDE',
    );
    expect(codeOf(() => g.assert('stale', [exists('scan_gates', { mode: 'live' })]))).toBe(
      'GRANT_SCOPE_OVERRIDE',
    );
    expect(codeOf(() => exists('users', { id: 'x' }))).toBe('GRANT_NO_EDGE');
    expect(codeOf(() => exists('not_a_table', { a: 1 }))).toBe('GRANT_NO_EDGE');
    expect(codeOf(() => exists('scan_gates', {}))).toBe('GRANT_BAD_PURPOSE');
    const platform = grant(route, {
      purpose: 'platform.test.cond',
      principal: await platformPrincipal(s),
    });
    const st = platform.assert('stale', [exists('scan_gates', { pass_id: s.pass.id })]);
    const { sql } = builtOf(st);
    expect(sql).not.toContain('x.org_id');
    expect(sql).toContain('x.pass_id = ? AND 1 = 1');
    const tenant = g.assert('stale', [exists('scan_gates', { pass_id: s.pass.id })]);
    expect(builtOf(tenant).sql).toContain('x.org_id = g.org_id AND x.mode = g.mode');
  });

  it('settings and orgs rows use their own tenant column', async () => {
    const { s, route, member } = await setupGrant('cond-b-settings');
    await run(db, "INSERT INTO settings (scope, key, value, updated_at) VALUES (?, 'ck', '1', 1)", [
      `org:${s.org.id}`,
    ]);
    const mk = () =>
      grant(route, { purpose: 'org.test.cond', principal: member({ mode: undefined }) });
    expect(await sees(mk(), exists('settings', { key: 'ck' }))).toBe(true);
    expect(await sees(mk(), exists('settings', { key: 'missing' }))).toBe(false);
    expect(codeOf(() => mk().assert('stale', [exists('settings', { scope: 'x' })]))).toBe(
      'GRANT_SCOPE_OVERRIDE',
    );
    expect(await sees(mk(), exists('orgs', { slug: s.org.slug }))).toBe(true);
  });
});

describe('B: tenantSql', () => {
  const ok = async (
    sql: string,
    params: (string | number)[] = [],
    scope: 'org_mode' | 'org' = 'org_mode',
  ) => {
    const { s, route, member } = await setupGrant(`tsql-${Math.abs(hash(sql))}`);
    const g =
      scope === 'org_mode'
        ? grant(route, { purpose: 'org_mode.test.cond', principal: member() })
        : grant(route, { purpose: 'org.test.cond', principal: member({ mode: undefined }) });
    g.assert('stale', [
      tenantSql(
        sql,
        params.map((p) => (p === '$pass' ? s.pass.id : p)),
      ),
    ]);
    return refusal(g.commit());
  };
  const hash = (x: string) => [...x].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7);

  it('accepts the tenant forms and a quoted mode (3)', async () => {
    expect(
      await ok('EXISTS (SELECT 1 FROM passes x WHERE x.id = ? AND x.org_id = {org})', ['$pass']),
    ).toBeNull();
    expect(
      await ok('EXISTS (SELECT 1 FROM passes x WHERE x.id = ? AND {org} = x.org_id)', ['$pass']),
    ).toBeNull();
    expect(
      await ok('EXISTS (SELECT 1 FROM passes x WHERE x.id = ? AND x.mode = {mode})', ['$pass']),
    ).toBeNull();
    expect(
      await ok('EXISTS (SELECT 1 FROM passes x WHERE x.id = ? AND {mode} = x.mode)', ['$pass']),
    ).toBeNull();
    expect(
      await ok('EXISTS (SELECT 1 FROM templates x WHERE x.org_id IS NULL OR x.org_id = {org})'),
    ).toBeNull();
    expect(
      await ok("'mode' = 'mode' AND 'org_id = ?' = 'org_id = ?' AND ';--' = ';--'"),
    ).toBeNull();
    expect(
      await ok('EXISTS (SELECT 1 FROM passes x WHERE x.id = ? AND x.org_id = {org})', ['nope']),
    ).not.toBeNull();
  });

  it('rejects request-bound tenants, writes and comments, and bad markers (4)', async () => {
    const bad = (sql: string, params: (string | number)[] = []) =>
      codeOf(() => tenantSql(sql, params));
    expect(bad('x.org_id = ?', [1])).toBe('GRANT_SCOPE_OVERRIDE');
    expect(
      bad('EXISTS (SELECT 1 FROM passes x JOIN passes y ON 1 WHERE x.org_id = y.org_id)'),
    ).toBe('GRANT_SCOPE_OVERRIDE');
    expect(bad('EXISTS (SELECT org_id FROM passes x)')).toBe('GRANT_SCOPE_OVERRIDE');
    expect(bad('EXISTS (SELECT 1 FROM passes x WHERE x.mode IN (?))', ['live'])).toBe(
      'GRANT_SCOPE_OVERRIDE',
    );
    expect(bad("EXISTS (SELECT 1 FROM settings x WHERE x.scope = 'org:a')")).toBe(
      'GRANT_SCOPE_OVERRIDE',
    );
    expect(bad('EXISTS (SELECT 1 FROM scan_gates x WHERE x.scope = ?)', [''])).toBeNull();
    for (const sql of [
      '1 = 1; SELECT 1',
      '1 = 1 -- c',
      '1 = 1 /* c */',
      'EXISTS (UPDATE passes SET a = 1)',
      'x IN (SELECT 1) AND DELETE',
    ])
      expect(bad(sql), sql).toBe('GRANT_SCOPE_OVERRIDE');
    expect(bad('EXISTS (SELECT 1 FROM passes g WHERE g.org_id = {org})')).toBe(
      'GRANT_SCOPE_OVERRIDE',
    );
    expect(bad('{nope} = 1')).toBe('GRANT_SCOPE_OVERRIDE');
    expect(bad("x = 'unterminated")).toBe('GRANT_SCOPE_OVERRIDE');
    expect(bad('x = ?', [])).toBe('tenantSql parameter count mismatch');
    expect(bad('x = 1', [1])).toBe('tenantSql parameter count mismatch');
  });

  it('{mode} needs org_mode and {org} needs a tenant', async () => {
    const { s, route, member } = await setupGrant('tsql-scope');
    const orgG = grant(route, { purpose: 'org.test.cond', principal: member({ mode: undefined }) });
    expect(
      codeOf(() =>
        orgG.assert('stale', [tenantSql('EXISTS (SELECT 1 FROM passes x WHERE x.mode = {mode})')]),
      ),
    ).toBe('GRANT_SCOPE_OVERRIDE');
    const platform = grant(route, {
      purpose: 'platform.test.cond',
      principal: await platformPrincipal(s),
    });
    expect(
      codeOf(() =>
        platform.assert('stale', [
          tenantSql('EXISTS (SELECT 1 FROM passes x WHERE x.org_id = {org})'),
        ]),
      ),
    ).toBe('GRANT_SCOPE_OVERRIDE');
  });

  it('tenantCheck ports the template lineage check: a template of another org refuses, a platform template passes (5)', async () => {
    const { s, route, member } = await setupGrant('tsql-lineage');
    const other = await setupGrant('tsql-lineage-other');
    const check = () =>
      tenantCheck(
        'lineage',
        "EXISTS (SELECT 1 FROM passes p JOIN templates t ON t.id = p.template_id WHERE p.id = ? AND t.status = 'active' AND (t.org_id IS NULL OR t.org_id = {org}))",
        [s.pass.id],
      );
    const commit = () =>
      grant(route, {
        purpose: 'org_mode.test.cond',
        principal: member(),
        checks: [check()],
      }).commit();
    const tpl = await db
      .prepare(
        'SELECT template_id AS id, (SELECT org_id FROM templates WHERE id = p.template_id) AS o FROM passes p WHERE id = ?',
      )
      .bind(s.pass.id)
      .first<{ id: string; o: string | null }>();
    expect(tpl?.o ?? null).toBeNull();
    await expect(commit()).resolves.toBeDefined();
    await run(db, 'UPDATE templates SET org_id = ? WHERE id = ?', [other.s.org.id, tpl?.id ?? '']);
    expect(await refusal(commit())).toMatchObject({ code: 'LINEAGE_CHANGED' });
    await run(db, 'UPDATE templates SET org_id = ? WHERE id = ?', [s.org.id, tpl?.id ?? '']);
    await expect(commit()).resolves.toBeDefined();
    expect(() => condCheck('lineage')).toThrow();
  });
});

describe('B: when is evaluated at statement time, checks and require before the batch (6)', () => {
  it('a later statement sees an earlier insert; a check and require: one on the same row refuse', async () => {
    const { route, member } = await setupGrant('cond-when');
    const mk = (checks = [] as ReturnType<typeof exactlyOne>[]) =>
      grant(route, { purpose: 'org.test.cond', principal: member({ mode: undefined }), checks });
    const has = (key: string) =>
      db
        .prepare('SELECT count(*) AS n FROM settings WHERE key = ?')
        .bind(key)
        .first<{ n: number }>();
    const g = mk();
    g.insertSelect('settings', ['key', 'value', 'updated_at'], ['w-first', '1', 1]);
    g.insertSelect('settings', ['key', 'value', 'updated_at'], ['w-second', '1', 1], {
      when: [exists('settings', { key: 'w-first' })],
    });
    g.insertSelect('settings', ['key', 'value', 'updated_at'], ['w-third', '1', 1], {
      when: [notExists('settings', { key: 'w-first' })],
    });
    await g.commit();
    expect((await has('w-second'))?.n).toBe(1);
    expect((await has('w-third'))?.n).toBe(0);
    // The same row as a pre-batch check: absent before the batch, so the grant is refused.
    const checked = mk([exactlyOne('settings', { key: 'w-new' })]);
    checked.insertSelect('settings', ['key', 'value', 'updated_at'], ['w-new', '1', 1]);
    expect(await refusal(checked.commit())).toMatchObject({ code: 'LINEAGE_CHANGED' });
    const required = mk();
    required.insertSelect('settings', ['key', 'value', 'updated_at'], ['w-req', '1', 1]);
    required.update('settings', { set: { value: '2' }, where: { key: 'w-req' }, require: 'one' });
    expect(await refusal(required.commit())).toMatchObject({ code: 'LINEAGE_CHANGED' });
    expect((await has('w-req'))?.n).toBe(0);
    await explains('SELECT 1', []);
  });
});

describe('F1: {row} narrows an update, and only an update, delete or joined when (23)', () => {
  it('is refused in checks, insertSelect and upsert when, and as {row}.org_id and {row}.mode', async () => {
    const { route, member } = await setupGrant('row-refused');
    const row = tenantSql('{row}.key = ?', ['k']);
    expect(
      codeOf(() =>
        grant(route, {
          purpose: 'org.test.cond',
          principal: member({ mode: undefined }),
          checks: [tenantCheck('lineage', '{row}.key = ?', ['k'])],
        }),
      ),
    ).toBe('GRANT_SCOPE_OVERRIDE');
    const g = grant(route, { purpose: 'org.test.cond', principal: member({ mode: undefined }) });
    expect(
      codeOf(() =>
        g.insertSelect('settings', ['key', 'value', 'updated_at'], ['k', '1', 1], { when: [row] }),
      ),
    ).toBe('GRANT_SCOPE_OVERRIDE');
    expect(
      codeOf(() =>
        g.upsert('settings', ['key', 'value', 'updated_at'], ['k', '1', 1], {
          update: ['value'],
          when: [row],
        }),
      ),
    ).toBe('GRANT_SCOPE_OVERRIDE');
    expect(codeOf(() => g.assert('stale', [row]))).toBe('GRANT_SCOPE_OVERRIDE');
    expect(codeOf(() => tenantSql('{row}.org_id = {org}'))).toBe('GRANT_SCOPE_OVERRIDE');
    expect(codeOf(() => tenantSql('{row}.mode = {mode}'))).toBe('GRANT_SCOPE_OVERRIDE');
    expect(codeOf(() => tenantSql('{row} . mode = {mode}'))).toBe('GRANT_SCOPE_OVERRIDE');
  });

  it('narrows: a row of another org that matches the {row} condition is not written', async () => {
    const a = await setupGrant('row-a');
    const b = await setupGrant('row-b');
    await insertGate({ passId: a.s.pass.id, orgId: a.s.org.id, count: 2 });
    await insertGate({ passId: b.s.pass.id, orgId: b.s.org.id, count: 2 });
    const g = grant(a.route, { purpose: 'org_mode.test.cond', principal: a.member() });
    const st = g.update('scan_gates', {
      set: { state: 'out' },
      where: { action_id: 'act' },
      when: [
        tenantSql(
          '{row}.count >= ? AND EXISTS (SELECT 1 FROM passes x WHERE x.id = {row}.pass_id AND x.org_id = {org})',
          [2],
        ),
      ],
      returning: ['pass_id'],
    });
    expect(builtOf(st).sql).toContain('scan_gates.count >= ?');
    const res = await g.commit();
    expect(resultRows<{ action_id: string }>(res, g.indexOf(st)).length).toBe(1);
    expect((await gateRows(a.s.pass.id))[0]?.state).toBe('out');
    expect((await gateRows(b.s.pass.id))[0]?.state).toBe('in');
  });

  it('joined and delete take {row} too, and the statements compile', async () => {
    const { route, member } = await setupGrant('row-joined');
    const g = grant(route, { purpose: 'org_mode.test.cond', principal: member() });
    const j = g.joined('scan_event_templates', {
      where: { template_id: 't' },
      delete: true,
      when: [tenantSql('{row}.template_id = ?', ['t'])],
    });
    const d = g.delete('scan_gates', {
      where: { action_id: 'x' },
      when: [tenantSql('{row}.count = 1')],
    });
    for (const st of [j, d]) await explains(builtOf(st).sql, builtOf(st).params);
    expect(builtOf(j).sql).toContain('scan_event_templates.template_id = ?');
  });
});

describe('F2: insertSelect from a tenant source row (24)', () => {
  const seed = async (label: string) => {
    const x = await setupGrant(label);
    const tpl = await db
      .prepare('SELECT template_id AS t FROM passes WHERE id = ?')
      .bind(x.s.pass.id)
      .first<{ t: string }>();
    return { ...x, tpl: tpl?.t ?? '' };
  };
  const copyGate = (
    g: ReturnType<typeof grant>,
    passId: string,
    extra: Record<string, unknown> = {},
  ) =>
    g.insertSelect(
      'scan_gates',
      ['action_id', 'scope', 'kind', 'state', 'first_at', 'last_at', 'last_scan_id'],
      ['act', '', 'check_in', 'in', 1, 1, 'scan-x'],
      {
        from: {
          table: 'passes',
          where: { id: passId },
          copy: { pass_id: 'id', template_id: 'template_id' },
        },
        returning: ['pass_id'],
        ...extra,
      },
    );

  it('takes org and mode from the grant and the values from the tenant source row', async () => {
    const { s, route, member } = await seed('from-ok');
    const g = grant(route, { purpose: 'org_mode.test.cond', principal: member() });
    const st = copyGate(g, s.pass.id, { when: [exists('passes', { id: s.pass.id })] });
    const { params } = builtOf(st);
    expect(params).toEqual([
      'act',
      '',
      'check_in',
      'in',
      1,
      1,
      'scan-x',
      g.id,
      s.pass.id,
      s.pass.id,
    ]);
    const res = await g.commit();
    expect(resultRows<{ action_id: string }>(res, g.indexOf(st)).length).toBe(1);
    const row = (await gateRows(s.pass.id))[0];
    expect(row).toMatchObject({ org_id: s.org.id, mode: 'live', pass_id: s.pass.id });
  });

  it('copies nothing from a source row of another org or mode', async () => {
    const a = await seed('from-a');
    const b = await seed('from-b');
    const test = await (await import('../../../test/helpers/index.ts')).makePass(a.s.f, {
      orgId: a.s.org.id,
      template: a.s.template.resolved,
      mode: 'test',
    });
    const g = grant(a.route, { purpose: 'org_mode.test.cond', principal: a.member() });
    const foreign = copyGate(g, b.s.pass.id);
    const sandbox = copyGate(g, test.id);
    const res = await g.commit();
    expect(resultRows<{ action_id: string }>(res, g.indexOf(foreign)).length).toBe(0);
    expect(resultRows<{ action_id: string }>(res, g.indexOf(sandbox)).length).toBe(0);
    expect(await gateRows(b.s.pass.id)).toHaveLength(0);
    expect(await gateRows(test.id)).toHaveLength(0);
    const orgWide = grant(a.route, {
      purpose: 'org.test.cond',
      principal: a.member({ mode: undefined }),
    });
    expect(
      codeOf(() =>
        orgWide.insertSelect('scan_gates', ['action_id'], ['x'], {
          from: { table: 'passes', where: { id: test.id }, copy: { pass_id: 'id' } },
        }),
      ),
    ).toBeNull();
  });

  it('refuses owned columns, org-less sources, overlaps and an empty where', async () => {
    const { s, route, member } = await seed('from-bad');
    const g = grant(route, { purpose: 'org_mode.test.cond', principal: member() });
    const from = (over: Record<string, unknown>) => ({
      table: 'passes',
      where: { id: s.pass.id },
      copy: { pass_id: 'id' },
      ...over,
    });
    const run1 = (f: ReturnType<typeof from>, columns = ['action_id'], values: string[] = ['x']) =>
      codeOf(() => g.insertSelect('scan_gates', columns, values, { from: f as never }));
    expect(run1(from({ copy: { org_id: 'id' } }))).toBe('GRANT_SCOPE_OVERRIDE');
    expect(run1(from({ copy: { mode: 'mode' } }))).toBe('GRANT_SCOPE_OVERRIDE');
    expect(run1(from({ copy: { pass_id: 'org_id' } }))).toBe('GRANT_SCOPE_OVERRIDE');
    expect(run1(from({ copy: { pass_id: 'mode' } }))).toBe('GRANT_SCOPE_OVERRIDE');
    expect(run1(from({ where: { org_id: 'x' } }))).toBe('GRANT_SCOPE_OVERRIDE');
    expect(run1(from({ table: 'pass_assets' }))).toBe('GRANT_NO_EDGE');
    expect(run1(from({ table: 'users' }))).toBe('GRANT_NO_EDGE');
    expect(run1(from({ copy: { action_id: 'id' } }))).toBe('GRANT_BAD_PURPOSE');
    expect(run1(from({ where: {} }))).toBe('GRANT_BAD_PURPOSE');
    expect(run1(from({ copy: {} }))).toBe('GRANT_BAD_PURPOSE');
    expect(
      codeOf(() =>
        g.upsert('scan_gates', ['pass_id', 'action_id', 'scope'], ['p', 'a', ''], {
          update: ['pass_id'],
          from: from({}),
        } as never),
      ),
    ).toBe('GRANT_BAD_PURPOSE');
    expect(
      codeOf(() =>
        g.insertJoined('scan_event_templates', {
          parents: { event_id: 'e' },
          columns: ['template_id'],
          values: ['t'],
          from: from({}),
        } as never),
      ),
    ).toBe('GRANT_BAD_PURPOSE');
  });
});

void isNotNull;
