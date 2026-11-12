import { describe, expect, it } from 'vitest';
import { grant } from './authority.ts';
import { exists } from './authority-cond.ts';
import { maxNow } from './authority-expr.ts';
import { codeOf, count, db, gateRows, insertGate, resultRows } from './authority-ext-fixtures.ts';
import { builtOf } from './authority-granted.ts';
import { setupGrant } from './authority-test-fixtures.ts';
import { first, run } from './db.ts';

const GATE = [
  'pass_id',
  'action_id',
  'scope',
  'template_id',
  'kind',
  'state',
  'count',
  'first_at',
  'last_at',
  'last_scan_id',
];
const gateValues = (passId: string, scan: string, state = 'in', at = 100): (string | number)[] => [
  passId,
  'act',
  '',
  'tpl',
  'check_in',
  state,
  1,
  at,
  at,
  scan,
];

describe('C: upsert insert path (7)', () => {
  it('takes org and mode from the grant', async () => {
    const { s, route, member } = await setupGrant('up-insert');
    const g = grant(route, { purpose: 'org_mode.test.up', principal: member() });
    g.upsert('scan_gates', GATE, gateValues(s.pass.id, 'scan-1'), { update: ['state'] });
    await g.commit();
    expect((await gateRows(s.pass.id))[0]).toMatchObject({
      org_id: s.org.id,
      mode: 'live',
      state: 'in',
      last_scan_id: 'scan-1',
    });
  });

  it('refuses tenant, conflict and duplicate targets and owned copy sources', async () => {
    const { s, route, member } = await setupGrant('up-refuse');
    const g = grant(route, { purpose: 'org_mode.test.up', principal: member() });
    const up = (o: Record<string, unknown>, columns = GATE) =>
      codeOf(() =>
        g.upsert(
          'scan_gates',
          columns,
          columns.map(() => 1),
          o as never,
        ),
      );
    expect(up({ update: ['state'] }, ['org_id', ...GATE])).toBe('GRANT_SCOPE_OVERRIDE');
    expect(up({ update: ['state'] }, ['mode', ...GATE])).toBe('GRANT_SCOPE_OVERRIDE');
    for (const key of ['update', 'inc'])
      for (const col of ['org_id', 'mode', 'pass_id', 'action_id', 'scope'])
        expect(up({ [key]: [col] }), `${key} ${col}`).toBe('GRANT_SCOPE_OVERRIDE');
    for (const col of ['org_id', 'mode', 'pass_id'])
      expect(up({ copy: { [col]: 'state' } }), `copy ${col}`).toBe('GRANT_SCOPE_OVERRIDE');
    expect(up({ set: { org_id: 'x' } })).toBe('GRANT_SCOPE_OVERRIDE');
    expect(up({ set: { mode: 'test' } })).toBe('GRANT_SCOPE_OVERRIDE');
    expect(up({ copy: { prev_state: 'org_id' } })).toBe('GRANT_SCOPE_OVERRIDE');
    expect(up({ copy: { prev_state: 'mode' } })).toBe('GRANT_SCOPE_OVERRIDE');
    expect(up({ copy: { prev_state: 'state' }, update: ['state'], where: { org_id: 'x' } })).toBe(
      'GRANT_SCOPE_OVERRIDE',
    );
    expect(up({ copy: { prev_state: 'bad name' } })).toBe('GRANT_BAD_IDENTIFIER');
    expect(up({ update: ['state'], inc: ['state'] })).toBe('GRANT_BAD_PURPOSE');
    expect(up({ update: ['state'], set: { state: 'x' } })).toBe('GRANT_BAD_PURPOSE');
    expect(up({})).toBe('GRANT_BAD_PURPOSE');
    expect(up({ update: ['prev_state'] })).toBe('GRANT_SCOPE_OVERRIDE');
    expect(up({ copy: { prev_state: 'state' } }, GATE.slice(1))).toBe('GRANT_BAD_PURPOSE');
    expect(
      codeOf(() =>
        g.upsert('scan_gates', GATE, gateValues(s.pass.id, 'x'), {
          doNothing: true,
          update: ['state'],
        }),
      ),
    ).toBe('GRANT_BAD_PURPOSE');
    expect(
      codeOf(() =>
        g.upsert('scan_gates', GATE, gateValues(s.pass.id, 'x'), {
          doNothing: true,
          where: { state: 'in' },
        }),
      ),
    ).toBe('GRANT_BAD_PURPOSE');
    expect(codeOf(() => g.upsert('passes', ['id'], ['x'], { doNothing: true }))).toBe(
      'GRANT_BAD_PURPOSE',
    );
  });
});

describe('C: upsert conflict path (8)', () => {
  const gateUpsert = (
    g: ReturnType<typeof grant>,
    passId: string,
    scan: string,
    o: Record<string, unknown> = {},
  ) =>
    g.upsert('scan_gates', GATE, gateValues(passId, scan, 'out', 200), {
      copy: { prev_state: 'state', prev_last_at: 'last_at', prev_scan_id: 'last_scan_id' },
      update: ['state', 'last_at', 'last_scan_id'],
      inc: ['count'],
      returning: ['last_scan_id'],
      ...o,
    });

  it('copy stores the old values, update stores excluded, inc adds one', async () => {
    const { s, route, member } = await setupGrant('up-conflict');
    await insertGate({ passId: s.pass.id, orgId: s.org.id, lastScan: 'scan-0', lastAt: 100 });
    const g = grant(route, { purpose: 'org_mode.test.up', principal: member() });
    const st = gateUpsert(g, s.pass.id, 'scan-1');
    const res = await g.commit();
    expect(resultRows(res, g.indexOf(st))).toEqual([{ last_scan_id: 'scan-1' }]);
    expect((await gateRows(s.pass.id))[0]).toMatchObject({
      state: 'out',
      last_at: 200,
      last_scan_id: 'scan-1',
      count: 2,
      prev_state: 'in',
      prev_last_at: 100,
      prev_scan_id: 'scan-0',
    });
  });

  it('a false where leaves the row byte-identical and returns no row; set uses vetted expressions', async () => {
    const { s, route, member } = await setupGrant('up-where');
    await insertGate({ passId: s.pass.id, orgId: s.org.id, lastScan: 'scan-0' });
    const before = JSON.stringify(await gateRows(s.pass.id));
    const g = grant(route, { purpose: 'org_mode.test.up', principal: member() });
    const miss = gateUpsert(g, s.pass.id, 'scan-1', { where: { state: 'used' } });
    const same = gateUpsert(g, s.pass.id, 'scan-1', { where: { last_scan_id: 'scan-0' } });
    const res = await g.commit();
    expect(resultRows(res, g.indexOf(miss))).toEqual([]);
    expect(resultRows(res, g.indexOf(same))).toEqual([{ last_scan_id: 'scan-1' }]);
    expect(before).not.toBe(JSON.stringify(await gateRows(s.pass.id)));
    const frozen = JSON.stringify(await gateRows(s.pass.id));
    const g2 = grant(route, { purpose: 'org_mode.test.up', principal: member() });
    const none = gateUpsert(g2, s.pass.id, 'scan-2', { where: { last_scan_id: 'scan-0' } });
    const res2 = await g2.commit();
    expect(resultRows(res2, g2.indexOf(none))).toEqual([]);
    expect(JSON.stringify(await gateRows(s.pass.id))).toBe(frozen);
    const g3 = grant(route, { purpose: 'org_mode.test.up', principal: member() });
    g3.upsert('scan_gates', GATE, gateValues(s.pass.id, 'scan-3'), {
      set: { last_at: maxNow(500) },
      update: ['state'],
    });
    await g3.commit();
    expect((await gateRows(s.pass.id))[0]?.last_at).toBe(500);
  });
});

describe('C: the tenant guard on DO UPDATE (9)', () => {
  it('a conflicting row of another org, or another mode, is not touched', async () => {
    const a = await setupGrant('up-guard-a');
    const b = await setupGrant('up-guard-b');
    // Same primary key (pass_id, action_id, scope), owned by org B.
    await insertGate({ passId: a.s.pass.id, orgId: b.s.org.id, lastScan: 'b-scan' });
    const before = JSON.stringify(await gateRows(a.s.pass.id));
    const g = grant(a.route, { purpose: 'org_mode.test.up', principal: a.member() });
    const st = g.upsert('scan_gates', GATE, gateValues(a.s.pass.id, 'a-scan', 'out'), {
      update: ['state', 'last_scan_id'],
      inc: ['count'],
      returning: ['last_scan_id'],
    });
    expect(builtOf(st).sql).toContain(
      'WHERE scan_gates.org_id = excluded.org_id AND scan_gates.mode = excluded.mode',
    );
    const res = await g.commit();
    expect(resultRows(res, g.indexOf(st))).toEqual([]);
    expect(JSON.stringify(await gateRows(a.s.pass.id))).toBe(before);
    // Same org, other mode.
    await run(db, 'DELETE FROM scan_gates WHERE pass_id = ?', [a.s.pass.id]);
    await insertGate({ passId: a.s.pass.id, orgId: a.s.org.id, mode: 'test', lastScan: 't-scan' });
    const modeBefore = JSON.stringify(await gateRows(a.s.pass.id));
    const g2 = grant(a.route, { purpose: 'org_mode.test.up', principal: a.member() });
    const st2 = g2.upsert('scan_gates', GATE, gateValues(a.s.pass.id, 'a-scan', 'out'), {
      update: ['state'],
      returning: ['state'],
    });
    const res2 = await g2.commit();
    expect(resultRows(res2, g2.indexOf(st2))).toEqual([]);
    expect(JSON.stringify(await gateRows(a.s.pass.id))).toBe(modeBefore);
  });

  it('an org grant guards the org only; settings keep working with only the guard added', async () => {
    const { s, route, member } = await setupGrant('up-guard-settings');
    const save = async (v: string) => {
      const g = grant(route, { purpose: 'org.test.up', principal: member({ mode: undefined }) });
      const st = g.upsert('settings', ['key', 'value', 'updated_at'], ['gk', v, 1], {
        update: ['value'],
      });
      await g.commit();
      return builtOf(st).sql;
    };
    await save('1');
    const sql = await save('2');
    expect(sql).toContain(
      'ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value WHERE settings.scope = excluded.scope',
    );
    expect(
      (
        await first<{ value: string }>(
          db,
          'SELECT value FROM settings WHERE scope = ? AND key = ?',
          [`org:${s.org.id}`, 'gk'],
        )
      )?.value,
    ).toBe('2');
  });
});

describe('C: doNothing (10, 11)', () => {
  const CLAIM = [
    'id',
    'actor_type',
    'actor_id',
    'actor_key',
    'idempotency_key',
    'request_hash',
    'method',
    'at',
  ];
  const claimValues = (id: string): (string | number)[] => [
    id,
    'scanner',
    's1',
    'scanner:s1',
    'idem-1',
    'h',
    'camera',
    5,
  ];

  it('the second claim of a key returns no row and the batch still commits', async () => {
    const { route, member } = await setupGrant('up-claim');
    const claim = async (id: string) => {
      const g = grant(route, { purpose: 'org_mode.test.up', principal: member() });
      const st = g.upsert('scans', CLAIM, claimValues(id), {
        doNothing: true,
        returning: ['id', 'at'],
      });
      return resultRows(await g.commit(), g.indexOf(st));
    };
    expect(await claim('claim-1')).toEqual([{ id: 'claim-1', at: 5 }]);
    expect(await claim('claim-2')).toEqual([]);
    expect(await count("SELECT count(*) AS n FROM scans WHERE idempotency_key = 'idem-1'")).toBe(1);
  });

  it('10 concurrent grants over one gate: 10 commit, one wins, a won-gated write lands only for it', async () => {
    const { s, route, member } = await setupGrant('up-race');
    const winners = await Promise.all(Array.from({ length: 10 }, (_, i) => racer(i)));
    async function racer(i: number) {
      const g = grant(route, { purpose: 'org_mode.test.up', principal: member() });
      const gate = g.upsert('scan_gates', GATE, gateValues(s.pass.id, `scan-${i}`), {
        doNothing: true,
        returning: ['last_scan_id'],
      });
      g.insertSelect('settings', ['key', 'value', 'updated_at'], [`won-${i}`, '1', 1], {
        when: [
          exists('scan_gates', {
            pass_id: s.pass.id,
            action_id: 'act',
            scope: '',
            last_scan_id: `scan-${i}`,
          }),
        ],
      });
      return resultRows(await g.commit(), g.indexOf(gate)).length;
    }
    expect(winners.reduce((a, b) => a + b, 0)).toBe(1);
    const rows = await gateRows(s.pass.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.count).toBe(1);
    expect(await count("SELECT count(*) AS n FROM settings WHERE key LIKE 'won-%'")).toBe(1);
  });
});

describe('C: budgets (12)', () => {
  it('an upsert over 40 binds is refused', async () => {
    const { route, member } = await setupGrant('up-budget');
    const g = grant(route, { purpose: 'org_mode.test.up', principal: member() });
    const wide = Array.from({ length: 38 }, (_, i) => `c${i}`);
    expect(
      codeOf(() =>
        g.upsert(
          'scan_gates',
          ['pass_id', 'action_id', 'scope', ...wide],
          ['p', 'a', '', ...wide.map(() => 1)],
          { update: ['c0'] },
        ),
      ),
    ).toBe('SQL_BIND_BUDGET');
  });
});
