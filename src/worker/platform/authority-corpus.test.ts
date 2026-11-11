// Representative scan write path statement sets (check-in, held, stop), built on the extended builder from
// fixtures. Asserts the budgets and that every statement compiles on D1. The sizes feed the design record.
import { describe, expect, it } from 'vitest';
import { type Grant, grant } from './authority.ts';
import type { Check } from './authority-checks.ts';
import { epochIs, passRow, rawCheck, rowIs } from './authority-checks.ts';
import { exists, not, tenantCheck, tenantSql } from './authority-cond.ts';
import { lte, ne } from './authority-expr.ts';
import { db, explains } from './authority-ext-fixtures.ts';
import { builtOf, type GrantedStatement, grantInsert } from './authority-granted.ts';
import { readPart, writePart } from './authority-include.ts';
import { setupGrant } from './authority-test-fixtures.ts';
import { first } from './db.ts';

type Setup = Awaited<ReturnType<typeof setupGrant>>;
const at = async (table: string, id: string, column: string) =>
  (await first<{ v: number }>(db, `SELECT ${column} AS v FROM ${table} WHERE id = ?`, [id]))?.v ??
  0;

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
const PRESENCE = [
  'pass_id',
  'scope',
  'state',
  'tracking',
  'entered_at',
  'first_at',
  'last_entry_at',
  'last_scan_id',
];
const LEDGER = ['id', 'pass_id', 'kind', 'device', 'actor_type', 'actor_id', 'data', 'at'];

const CORPUS_TABLES = ['counters', 'scan_gates', 'scan_presence', 'scans', 'pass_events'];
const COUNTS = 'INSERT INTO counters (key, window_start, count) SELECT ?, ?, 1 WHERE {grant}';

/** The scanner grant: actor, event, staff, session and pass checks of a check-in with a manager approver. */
async function scanChecks(x: Setup, passId: string): Promise<Check[]> {
  const { s } = x;
  return [
    epochIs(
      'scan_events',
      s.event.id,
      'config_epoch',
      await at('scan_events', s.event.id, 'config_epoch'),
    ),
    epochIs(
      'scanning_sessions',
      s.scanningSessionId,
      'config_epoch',
      await at('scanning_sessions', s.scanningSessionId, 'config_epoch'),
    ),
    rowIs(
      'scan_staff',
      s.staff.id,
      { disabled_at: null, auth_epoch: await at('scan_staff', s.staff.id, 'auth_epoch') },
      'staff',
    ),
    ...passRow(passId, await at('passes', passId, 'row_version')),
    tenantCheck(
      'lineage',
      "EXISTS (SELECT 1 FROM passes p JOIN templates t ON t.id = p.template_id WHERE p.id = ? AND t.status = 'active' AND (t.org_id IS NULL OR t.org_id = {org}))",
      [passId],
    ),
    rawCheck(
      'lineage',
      'NOT EXISTS (SELECT 1 FROM pass_credential_transfers pt WHERE pt.pass_id = ? AND pt.state = ?)',
      [passId, 'pending'],
    ),
  ];
}

function scannerGrant(x: Setup, purpose: string, checks: Check[]) {
  return x.s.scannerId
    ? {
        purpose,
        principal: { kind: 'scanner' as const, scannerId: x.s.scannerId, credentialEpoch: 0 },
        checks,
        tables: CORPUS_TABLES,
      }
    : { purpose, principal: x.member(), checks, tables: CORPUS_TABLES };
}

interface Built {
  g: Grant;
  input: ReturnType<typeof scannerGrant>;
  statements: GrantedStatement[];
}

function checkIn(x: Setup, input: ReturnType<typeof scannerGrant>): Built {
  const { s, route } = x;
  const g = grant(route, input);
  const statements: GrantedStatement[] = [];
  const id = s.pass.id;
  const won = exists('scan_gates', {
    pass_id: id,
    action_id: 'act',
    scope: '',
    last_scan_id: 'scan-1',
  });
  const isOk = exists('scans', { id: 'scan-1', outcome: 'ok' });
  const capacityOpen = tenantSql(
    "(SELECT count(*) FROM scan_gates witness WHERE witness.org_id = {org} AND witness.mode = {mode} AND witness.scope = ? AND witness.kind = 'check_in' AND witness.state = 'in') < ?",
    ['event:e1', 100],
  );
  const finalize = (
    outcome: string,
    reason: string | null,
    when: Parameters<typeof g.update>[1]['when'],
  ) =>
    g.update('scans', {
      set: {
        state: 'done',
        outcome,
        reason,
        pass_id: id,
        template_id: 'tpl',
        action_id: 'act',
        action_kind: 'check_in',
        pass_version: 1,
        override_of: null,
        approved_by: s.staff.id,
        direction: 'in',
        presence_scope: 'event:e1',
        event_id: 'e1',
      },
      where: { id: 'scan-1', state: 'pending', at: 5 },
      ...(when ? { when } : {}),
      returning: ['id'],
    });
  const gateValues = [id, 'act', '', 'tpl', 'check_in', 'in', 1, 10, 10, 'scan-1'];
  statements.push(
    g.upsert('scan_gates', GATE, gateValues, {
      copy: { prev_state: 'state', prev_last_at: 'last_at', prev_scan_id: 'last_scan_id' },
      update: ['state', 'last_at', 'last_scan_id'],
      inc: ['count'],
      where: { state: 'out', last_scan_id: ne('scan-1'), last_at: lte(5) },
      when: [capacityOpen],
      returning: ['last_scan_id'],
    }),
    g.upsert('scan_presence', PRESENCE, [id, 'event:e1', 'in', 1, 10, 10, 10, 'scan-1'], {
      copy: {
        prev_state: 'state',
        prev_tracking: 'tracking',
        prev_entered_at: 'entered_at',
        prev_first_at: 'first_at',
        prev_last_entry_at: 'last_entry_at',
        prev_scan_id: 'last_scan_id',
      },
      update: ['state', 'tracking', 'entered_at', 'last_entry_at', 'last_scan_id'],
      where: { last_scan_id: 'scan-0' },
      when: [won],
      returning: ['last_scan_id'],
    }),
    finalize('ok', null, [won]),
    finalize('heads_up', 'capacity_full', [not(capacityOpen)]),
    finalize('heads_up', 'already_done', undefined),
    g.insertSelect(
      'pass_events',
      LEDGER,
      ['ev-1', id, 'scan.ok', 'dev', 'scanner', 's1', '{}', 5],
      {
        when: [exists('scans', { id: 'scan-1', outcome: 'ok', reason: null })],
        returning: ['id'],
      },
    ),
    ...g.include(
      writePart(
        'INSERT INTO counters (key, window_start, count) SELECT ?, ?, 1 WHERE {grant} AND EXISTS (SELECT 1 FROM scans WHERE id = ? AND outcome = ?)',
        ['proof', 1, 'scan-1', 'ok'],
      ),
      readPart(
        'SELECT sc.id, sc.at FROM scans sc WHERE sc.org_id = {org} AND sc.mode = {mode} AND sc.id = ?',
        ['scan-1'],
      ),
      writePart(COUNTS, ['counts', 1]),
      writePart(COUNTS, ['refund', 1]),
    ),
    g.assert('stale', [exists('scans', { id: 'scan-1', state: 'done' })]),
    g.assert(
      'stale',
      [exists('scan_presence', { pass_id: id, scope: 'event:e1', last_scan_id: 'scan-1' })],
      { when: [isOk] },
    ),
  );
  return { g, input, statements };
}

function held(x: Setup, input: ReturnType<typeof scannerGrant>): Built {
  const { s, route } = x;
  const g = grant(route, input);
  const id = s.pass.id;
  const statements = [
    g.update('scans', {
      set: { state: 'done', outcome: 'heads_up', reason: 'in_progress', pass_id: id },
      where: { id: 'scan-2', state: 'pending', at: 5 },
      returning: ['id'],
    }),
    g.insertSelect(
      'pass_events',
      LEDGER,
      ['ev-2', id, 'scan.held', 'dev', 'scanner', 's1', '{}', 5],
      { returning: ['id'] },
    ),
    ...g.include(writePart(COUNTS, ['counts', 2]), writePart(COUNTS, ['refund', 2])),
    g.assert('stale', [exists('scans', { id: 'scan-2', state: 'done' })]),
  ];
  return { g, input, statements };
}

function stop(x: Setup, input: ReturnType<typeof scannerGrant>): Built {
  const g = grant(x.route, input);
  const statements = [
    g.update('scans', {
      set: { state: 'done', outcome: 'refused', reason: 'not_found' },
      where: { id: 'scan-3', state: 'pending', at: 5 },
      returning: ['id'],
    }),
    ...g.include(writePart(COUNTS, ['counts', 3]), writePart(COUNTS, ['refund', 3])),
    g.assert('stale', [exists('scans', { id: 'scan-3', state: 'done' })]),
  ];
  return { g, input, statements };
}

describe('statement corpus (22): the scan write path sets', () => {
  it('stay within the bind and size budgets and compile on D1', async () => {
    const x = await setupGrant('corpus-scan');
    const checks = await scanChecks(x, x.s.pass.id);
    const sets: [string, Built][] = [
      ['check_in', checkIn(x, scannerGrant(x, 'org_mode.scan.check_in', checks))],
      ['held', held(x, scannerGrant(x, 'org_mode.scan.held', checks))],
      ['stop', stop(x, scannerGrant(x, 'org_mode.scan.stop', checks.slice(0, 3)))],
      ['stop (passless)', stop(x, scannerGrant(x, 'org_mode.scan.stop', checks.slice(0, 3)))],
    ];
    const sizes: Record<string, number> = {};
    for (const [name, { g, input, statements }] of sets) {
      const insert = grantInsert(g.id, 'org_mode', input, [], 0);
      const { grant: gs, writes } = g.inspect();
      expect(gs.params, name).toBeLessThanOrEqual(90);
      expect(gs.bytes, name).toBeLessThan(32 * 1024);
      for (const w of writes) {
        expect(w.params, name).toBeLessThanOrEqual(40);
        expect(w.bytes, name).toBeLessThan(32 * 1024);
      }
      await explains(insert.sql, insert.params);
      for (const st of statements) {
        const { sql, params } = builtOf(st);
        await explains(sql, params);
      }
      sizes[name] = Math.max(...writes.map((w) => w.params));
    }
    // Design 4.7: the largest check-in write is 25 binds, held and stop 20.
    expect(sizes.check_in).toBeLessThanOrEqual(25);
    expect(sizes.held).toBeLessThanOrEqual(20);
    expect(sizes.stop).toBeLessThanOrEqual(20);
  });
});
