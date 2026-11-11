import { describe, expect, it } from 'vitest';
import { grant } from './authority.ts';
import { exactlyOne } from './authority-checks.ts';
import { codeOf, count, platformPrincipal, refusal, resultRows } from './authority-ext-fixtures.ts';
import { builtOf } from './authority-granted.ts';
import { readPart, writePart } from './authority-include.ts';
import { setupGrant } from './authority-test-fixtures.ts';

const TABLES = ['counters', 'widgets', 'scan_gates'];
const COUNTER = 'INSERT INTO counters (key, window_start, count) SELECT ?, ?, 1 WHERE {grant}';
const hits = (key: string) => count('SELECT count(*) AS n FROM counters WHERE key = ?', [key]);

describe('E: include markers (17)', () => {
  it('bind the grant id at each marker position and read the tenant from the grant row', async () => {
    const { s, route, member } = await setupGrant('inc-markers');
    const g = grant(route, { purpose: 'org_mode.test.inc', principal: member(), tables: TABLES });
    const [w] = g.include(writePart(COUNTER, ['inc-1', 1]));
    expect(builtOf(w as never).params).toEqual(['inc-1', 1, g.id]);
    const [r] = g.include(readPart('SELECT {org} AS o, ? AS v, {mode} AS m', [7]));
    expect(builtOf(r as never).params).toEqual([g.id, 7, g.id]);
    const res = await g.commit();
    expect(resultRows(res, g.indexOf(r as never))).toEqual([{ o: s.org.id, v: 7, m: 'live' }]);
    expect(await hits('inc-1')).toBe(1);
  });

  it('{org} under platform and {mode} under org are refused', async () => {
    const { s, route, member } = await setupGrant('inc-scope');
    const platform = grant(route, {
      purpose: 'platform.test.inc',
      principal: await platformPrincipal(s),
      tables: TABLES,
    });
    expect(codeOf(() => platform.include(readPart('SELECT {org}')))).toBe('GRANT_SCOPE_OVERRIDE');
    expect(codeOf(() => platform.include(readPart('SELECT {grant} AS ok')))).toBeNull();
    const orgG = grant(route, {
      purpose: 'org.test.inc',
      principal: member({ mode: undefined }),
      tables: TABLES,
    });
    expect(codeOf(() => orgG.include(readPart('SELECT {org}, {mode}')))).toBe(
      'GRANT_SCOPE_OVERRIDE',
    );
    expect(codeOf(() => orgG.include(readPart('SELECT {row}.x, {org}')))).toBe(
      'GRANT_SCOPE_OVERRIDE',
    );
    expect(codeOf(() => orgG.include(readPart('SELECT {org}, ?', [])))).toBe('GRANT_BAD_PURPOSE');
  });
});

describe('E: read parts (18)', () => {
  it('need {org}, refuse bound tenants and write words', async () => {
    const { route, member } = await setupGrant('inc-read');
    const g = grant(route, { purpose: 'org_mode.test.inc', principal: member(), tables: TABLES });
    const bad = (sql: string, params: (string | number)[] = []) =>
      codeOf(() => g.include(readPart(sql, params)));
    expect(bad('SELECT 1')).toBe('GRANT_SCOPE_OVERRIDE');
    expect(bad('SELECT 1 FROM passes WHERE org_id = ? AND {org} IS NOT NULL', ['x'])).toBe(
      'GRANT_SCOPE_OVERRIDE',
    );
    expect(bad('SELECT 1 FROM passes WHERE mode IN (?) AND {org} IS NOT NULL', ['live'])).toBe(
      'GRANT_SCOPE_OVERRIDE',
    );
    expect(bad('SELECT 1 FROM passes p WHERE ? = p.org_id AND {org} IS NOT NULL', ['x'])).toBe(
      'GRANT_SCOPE_OVERRIDE',
    );
    expect(bad('SELECT {org}; DELETE FROM passes')).toBe('GRANT_SCOPE_OVERRIDE');
    expect(bad('SELECT {org} -- c')).toBe('GRANT_SCOPE_OVERRIDE');
    expect(bad('WITH x AS (DELETE FROM counters RETURNING 1) SELECT {org}')).toBe(
      'GRANT_SCOPE_OVERRIDE',
    );
    expect(bad('PRAGMA table_info(passes) -- {org}')).toBe('GRANT_SCOPE_OVERRIDE');
    expect(bad("SELECT {org}, 'org_id = ?' AS lit")).toBeNull();
    const many = Array.from({ length: 91 }, () => 1);
    expect(bad(`SELECT {org}${many.map(() => ', ?').join('')}`, many)).toBe('SQL_BIND_BUDGET');
  });
});

describe('E: write parts (19)', () => {
  it('need {grant}, one target outside the guarded, authority and append-only tables', async () => {
    const { route, member } = await setupGrant('inc-write');
    const g = grant(route, { purpose: 'org_mode.test.inc', principal: member(), tables: TABLES });
    const bad = (sql: string, params: (string | number)[] = []) =>
      codeOf(() => g.include(writePart(sql, params)));
    expect(bad('INSERT INTO counters (key, window_start, count) SELECT 1, 1, 1')).toBe(
      'GRANT_SCOPE_OVERRIDE',
    );
    for (const table of [
      'passes',
      'scan_gates',
      'settings',
      'authority_grants',
      'template_release_heads',
      'audit_log',
    ])
      expect(['GRANT_UNGUARDED_TABLE', 'GRANT_SCOPE_OVERRIDE'], table).toContain(
        bad(`INSERT INTO ${table} (a) SELECT 1 WHERE {grant}`),
      );
    expect(bad('UPDATE passes SET a = 1 WHERE {grant}')).toBe('GRANT_UNGUARDED_TABLE');
    expect(bad('DELETE FROM scans WHERE {grant}')).toBe('GRANT_UNGUARDED_TABLE');
    expect(bad('INSERT INTO counters (key) SELECT 1 WHERE {grant}; DELETE FROM counters')).toBe(
      'GRANT_SCOPE_OVERRIDE',
    );
    expect(
      bad('INSERT INTO counters (key) SELECT 1 WHERE {grant} AND (UPDATE counters SET count = 1)'),
    ).toBe('GRANT_SCOPE_OVERRIDE');
    expect(bad('INSERT INTO widgets (org_id, x) SELECT 1, 2 WHERE {grant}')).toBe(
      'GRANT_SCOPE_OVERRIDE',
    );
    expect(bad('INSERT INTO widgets (mode, x) SELECT {org}, 2 WHERE {grant}')).toBe(
      'GRANT_SCOPE_OVERRIDE',
    );
    expect(bad('INSERT INTO widgets (org_id, x) SELECT {org}, ? WHERE {grant}', [1])).toBeNull();
    expect(bad('INSERT INTO widgets (org_id, mode) SELECT {org}, {mode} WHERE {grant}')).toBeNull();
    expect(
      bad('INSERT INTO widgets (org_id, x) SELECT ?, 2 WHERE {grant} AND org_id = ?', ['a', 'b']),
    ).toBe('GRANT_SCOPE_OVERRIDE');
    expect(bad('SELECT 1 WHERE {grant}')).toBe('GRANT_SCOPE_OVERRIDE');
    expect(
      bad(
        "INSERT INTO counters (key, window_start, count) VALUES ('x', 1, 1) ON CONFLICT (key, window_start) DO UPDATE SET count = count + 1 WHERE {grant}",
      ),
    ).toBeNull();
    const wide = Array.from({ length: 41 }, () => 1);
    expect(
      bad(
        `INSERT INTO counters (key) SELECT 1 WHERE {grant}${wide.map(() => ' AND ? = 1').join('')}`,
        wide,
      ),
    ).toBe('SQL_BIND_BUDGET');
  });
});

describe('E: parts are inert and ordered (20, 21)', () => {
  it('a part cannot run alone; indexOf matches the commit results, also after add', async () => {
    const { route, member } = await setupGrant('inc-order');
    const g = grant(route, { purpose: 'org_mode.test.inc', principal: member(), tables: TABLES });
    const part = writePart(COUNTER, ['inc-2', 1]);
    expect(typeof (part as { run?: unknown }).run).toBe('undefined');
    const first = g.update('scan_gates', {
      set: { state: 'x' },
      where: { pass_id: 'none' },
      returning: ['pass_id'],
    });
    const [w] = g.include(part) as [ReturnType<typeof g.audit>];
    expect(() => w.run()).toThrow(
      expect.objectContaining({ code: 'GRANT_STATEMENT_OUTSIDE_BATCH' }),
    );
    const late = g.unguarded(
      'INSERT INTO counters (key, window_start, count) SELECT ?, 1, 1 FROM authority_grants g WHERE g.id = ?',
      ['inc-3', g.id],
    );
    g.add(late, first);
    const [r] = g.include(readPart('SELECT {org} AS o, ? AS tag', ['late'])) as [typeof w];
    expect([g.indexOf(first), g.indexOf(w), g.indexOf(late), g.indexOf(r)]).toEqual([0, 1, 2, 3]);
    const res = await g.commit();
    expect(resultRows<{ tag: string }>(res, g.indexOf(r))[0]?.tag).toBe('late');
    expect(await hits('inc-2')).toBe(1);
    expect(await hits('inc-3')).toBe(1);
    expect(() => g.indexOf(late)).not.toThrow();
  });

  it('a denied grant rolls back its included writes', async () => {
    const { route, member } = await setupGrant('inc-denied');
    const g = grant(route, {
      purpose: 'org_mode.test.inc',
      principal: member(),
      tables: TABLES,
      checks: [exactlyOne('settings', { key: 'missing' })],
    });
    g.include(writePart(COUNTER, ['inc-denied', 1]));
    expect(await refusal(g.commit())).toMatchObject({ code: 'LINEAGE_CHANGED' });
    expect(await hits('inc-denied')).toBe(0);
  });
});
