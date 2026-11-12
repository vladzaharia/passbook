import { beforeAll, describe, expect, it } from 'vitest';
import { countD1 } from '../../../../test/helpers/index.ts';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { all, first, run, type SqlValue, stmt } from '../../platform/db.ts';
import type { EventRow } from '../events/repo.ts';
import {
  clearScanRetentionDeleteStmt,
  readVerifiedScanRetentionProofs,
  retentionProofCurrentPredicate,
  retentionProofIfRecordedStmt,
  scanRetentionCandidateSql,
  stageScanRetentionDeleteStmt,
} from './repo-scan-retention.ts';
import { registerRetentionOccupancyTests } from './repo-scan-retention-proof-occupancy-test-fixtures.ts';
import {
  ACTION,
  EMAIL,
  hardDelete,
  kit,
  MEMBER,
  scenario,
  scopedCount,
  setupRetentionProof,
  templateId,
  transition,
} from './repo-scan-retention-proof-setup-test-fixtures.ts';
import { scanSecretSlots } from './repo-secret-binds.ts';
import {
  InvalidScanRetentionProof,
  type PreparedScanRetentionProof,
  prepareScanRetentionDelete,
  prepareScanRetentionProof,
  verifyScanRetentionProof,
} from './scan-retention-proof.ts';
import { key } from './test-kit.ts';

beforeAll(setupRetentionProof);

describe('detached scan retention provenance', () => {
  it('keeps a signed generic receipt and exact event occupancy across a clean hard delete', async () => {
    const s = await scenario();
    const signed = await prepareScanRetentionProof(kit.env, s.eventRow, `s:${s.scanner.id}`, {
      actionId: ACTION,
    });
    expect(await verifyScanRetentionProof(kit.env, signed.proof, signed.scan)).toBe(true);
    expect(signed.proof.gateSnapshot).not.toBeNull();
    const before = await first<Record<string, unknown>>(
      kit.env.DB,
      'SELECT * FROM scan_retention_proofs WHERE scan_id=?',
      [s.scanId],
    );
    expect(before).toMatchObject({ scan_id: s.scanId, excluded: 0, invalidated: 0 });

    await hardDelete(s.pass);
    expect(await first(kit.env.DB, 'SELECT id FROM passes WHERE id=?', [s.pass.id])).toBeNull();
    expect(
      await first(kit.env.DB, 'SELECT id FROM pass_events WHERE id=?', [s.eventRow.id]),
    ).toBeNull();
    expect(await first(kit.env.DB, 'SELECT pass_id FROM scans WHERE id=?', [s.scanId])).toEqual({
      pass_id: null,
    });
    const after = await first<Record<string, unknown>>(
      kit.env.DB,
      'SELECT * FROM scan_retention_proofs WHERE scan_id=?',
      [s.scanId],
    );
    expect(after).toEqual(before);
    const safe = JSON.stringify(after);
    for (const secret of [s.pass.id, MEMBER, EMAIL, ACTION, s.scanner.token])
      expect(safe).not.toContain(secret);
    expect(after?.pass_ref).toMatch(/^[0-9a-f]{64}$/);
    expect(after?.mac).toMatch(/^[0-9a-f]{64}$/);
    expect(await scopedCount(kit.org.id, s.event.id)).toBe(1);
    expect(await scopedCount(kit.org.id, s.event.id, true)).toBe(1);
    expect(await scopedCount('other-org', s.event.id)).toBe(0);
    const retained = await first<Record<string, unknown>>(
      kit.env.DB,
      'SELECT * FROM scan_retained_gates WHERE scan_id=?',
      [s.scanId],
    );
    expect(retained).toMatchObject({
      scan_id: s.scanId,
      event_id: s.event.id,
      state: 'in',
      presence_state: 'in',
    });
    expect(JSON.stringify(retained)).not.toContain(s.pass.id);

    const counted = countD1(kit.env.DB);
    const verified = await readVerifiedScanRetentionProofs(
      counted.db,
      kit.env,
      { orgId: kit.org.id, mode: 'live' },
      [s.scanId, s.scanId],
    );
    expect(verified.has(s.scanId)).toBe(true);
    expect(counted.count()).toBe(1);
    expect(
      (
        await readVerifiedScanRetentionProofs(kit.env.DB, kit.env, { mode: 'live' }, [s.scanId])
      ).has(s.scanId),
    ).toBe(true);
    expect(
      (
        await readVerifiedScanRetentionProofs(
          kit.env.DB,
          kit.env,
          { orgId: 'other-org', mode: 'live' },
          [s.scanId],
        )
      ).size,
    ).toBe(0);
    expect(
      (
        await readVerifiedScanRetentionProofs(
          kit.env.DB,
          kit.env,
          { orgId: kit.org.id, mode: 'test' },
          [s.scanId],
        )
      ).size,
    ).toBe(0);
    expect(
      (
        await readVerifiedScanRetentionProofs(
          kit.env.DB,
          { KEK_V1: btoa('x'.repeat(32)) },
          { orgId: kit.org.id, mode: 'live' },
          [s.scanId],
        )
      ).size,
    ).toBe(0);

    const replay = await kit.post(s.scanner.headers, '/actions', s.request);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      kind: 'ok',
      scanId: s.scanId,
      replay: true,
      action: null,
      card: null,
      template: null,
      display: null,
      value: null,
    });
    await run(kit.env.DB, 'DELETE FROM scans WHERE id=?', [s.scanId]);
    expect(
      await first(kit.env.DB, 'SELECT scan_id FROM scan_retention_proofs WHERE scan_id=?', [
        s.scanId,
      ]),
    ).toBeNull();
    expect(
      await first(kit.env.DB, 'SELECT scan_id FROM scan_retained_gates WHERE scan_id=?', [
        s.scanId,
      ]),
    ).toBeNull();
  });

  it('keeps the original tenant and mode across bounded asynchronous reads', async () => {
    const first = await scenario();
    const second = await scenario();
    await hardDelete(first.pass);
    await hardDelete(second.pass);
    const scope: { orgId: string; mode: 'live' | 'test' } = { orgId: kit.org.id, mode: 'live' };
    const ids = [
      first.scanId,
      ...Array.from({ length: 87 }, (_, i) => `missing-${i}`),
      second.scanId,
    ];
    const pending = readVerifiedScanRetentionProofs(kit.env.DB, kit.env, scope, ids);
    scope.orgId = 'other-org';
    scope.mode = 'test';
    const proofs = await pending;
    expect([...proofs.keys()].sort()).toEqual([first.scanId, second.scanId].sort());
  });

  it('latches quarantine for signed and older unsigned scans even after unquarantine and direct delete', async () => {
    const s = await scenario();
    const heldResponse = await kit.post(s.scanner.headers, '/actions', {
      ...s.request,
      idempotencyKey: key(),
    });
    const held = (await heldResponse.json()) as ScanOutcome;
    expect(held.kind).toBe('heads_up');
    if (!held.scanId) throw new Error('Missing held scan ID');
    const legacy = kit.fx.ids.id();
    await run(
      kit.env.DB,
      `INSERT INTO scans
      (id,org_id,mode,pass_id,template_id,actor_type,actor_id,actor_key,idempotency_key,request_hash,method,state,outcome,at)
      VALUES (?,?,?, ?,?,'scanner',?,?,?,?,'camera','done','refused',?)`,
      [
        legacy,
        kit.org.id,
        'live',
        s.pass.id,
        templateId,
        s.scanner.id,
        `s:${s.scanner.id}`,
        legacy,
        legacy,
        kit.clock.now(),
      ],
    );
    await run(kit.env.DB, 'UPDATE passes SET test_data_quarantined=1 WHERE id=?', [s.pass.id]);
    expect(
      await all(
        kit.env.DB,
        'SELECT excluded,invalidated FROM scan_retention_proofs WHERE scan_id IN (?,?)',
        [s.scanId, held.scanId],
      ),
    ).toEqual([
      { excluded: 1, invalidated: 0 },
      { excluded: 1, invalidated: 0 },
    ]);
    expect(
      await all(
        kit.env.DB,
        'SELECT scan_id FROM scan_quarantine_exclusions WHERE scan_id IN (?,?,?)',
        [s.scanId, held.scanId, legacy],
      ),
    ).toHaveLength(3);
    await run(kit.env.DB, 'UPDATE passes SET test_data_quarantined=0 WHERE id=?', [s.pass.id]);
    await expect(
      run(kit.env.DB, 'UPDATE scan_retention_proofs SET excluded=0 WHERE scan_id=?', [s.scanId]),
    ).rejects.toThrow();
    await run(kit.env.DB, 'DELETE FROM passes WHERE id=?', [s.pass.id]);
    expect(
      (
        await readVerifiedScanRetentionProofs(kit.env.DB, kit.env, { mode: 'live' }, [
          s.scanId,
          held.scanId,
        ])
      ).size,
    ).toBe(0);
    expect(await scopedCount(kit.org.id, s.event.id)).toBe(0);
    const candidates = await all(
      kit.env.DB,
      `SELECT s.id FROM scans s WHERE s.id IN (?,?,?) AND ${scanRetentionCandidateSql('s')}`,
      [s.scanId, held.scanId, legacy],
    );
    expect(candidates).toEqual([]);
  });

  it('does not retain a gate or transient intent when a conditional deletion loses', async () => {
    const s = await scenario();
    const result = await hardDelete(s.pass, false);
    expect(result[1]?.results).toHaveLength(0);
    expect(await first(kit.env.DB, 'SELECT id FROM passes WHERE id=?', [s.pass.id])).not.toBeNull();
    expect(
      await first(kit.env.DB, 'SELECT scan_id FROM scan_retention_delete_intents WHERE scan_id=?', [
        s.scanId,
      ]),
    ).toBeNull();
    expect(
      await first(kit.env.DB, 'SELECT scan_id FROM scan_retained_gates WHERE scan_id=?', [
        s.scanId,
      ]),
    ).toBeNull();
    expect(
      await first(
        kit.env.DB,
        'SELECT excluded,invalidated FROM scan_retention_proofs WHERE scan_id=?',
        [s.scanId],
      ),
    ).toEqual({ excluded: 0, invalidated: 0 });
  });

  it('rejects directly forged retained gate states even with a staged deletion intent', async () => {
    const s = await scenario();
    const prepared = await prepareScanRetentionDelete(kit.env, s.pass);
    await stageScanRetentionDeleteStmt(kit.env.DB, s.pass.id, prepared).run();
    try {
      for (const [state, presence] of [
        ['out', 'out'],
        ['out', 'in'],
      ] as const) {
        await expect(
          run(
            kit.env.DB,
            `INSERT INTO scan_retained_gates
          (scan_id,org_id,mode,event_id,pass_ref,state,presence_state) VALUES (?,?,?,?,?,?,?)`,
            [s.scanId, kit.org.id, 'live', s.event.id, prepared.passRef, state, presence],
          ),
        ).rejects.toThrow();
      }
    } finally {
      await clearScanRetentionDeleteStmt(kit.env.DB, prepared).run();
    }
  });

  it('does not let REPLACE move an invalidated proof to another scan using its ledger event', async () => {
    const s = await scenario();
    const replacement = kit.fx.ids.id();
    await run(
      kit.env.DB,
      `INSERT INTO scans
      (id,org_id,mode,pass_id,template_id,event_id,actor_type,actor_id,actor_key,idempotency_key,
       request_hash,method,state,outcome,action_id,action_kind,at)
      VALUES (?,?,?,?,?,?,'scanner',?,?,?,?,'camera','done','ok',?,'check_in',?)`,
      [
        replacement,
        kit.org.id,
        'live',
        s.pass.id,
        templateId,
        s.event.id,
        s.scanner.id,
        `s:${s.scanner.id}`,
        replacement,
        replacement,
        ACTION,
        kit.clock.now(),
      ],
    );
    await run(kit.env.DB, "UPDATE pass_events SET data=json_set(data,'$.scanId',?) WHERE id=?", [
      replacement,
      s.eventRow.id,
    ]);
    expect(
      await first(kit.env.DB, 'SELECT invalidated FROM scan_retention_proofs WHERE scan_id=?', [
        s.scanId,
      ]),
    ).toEqual({ invalidated: 1 });
    await expect(
      run(
        kit.env.DB,
        `INSERT OR REPLACE INTO scan_retention_proofs
      (scan_id,org_id,mode,ledger_event_id,pass_ref,event_digest,scan_digest,gate_snapshot,presence_snapshot,mac,excluded,invalidated)
      SELECT ?,org_id,mode,ledger_event_id,pass_ref,event_digest,scan_digest,gate_snapshot,presence_snapshot,mac,0,0
      FROM scan_retention_proofs WHERE scan_id=?`,
        [replacement, s.scanId],
      ),
    ).rejects.toThrow();
    expect(
      await first(kit.env.DB, 'SELECT invalidated FROM scan_retention_proofs WHERE scan_id=?', [
        s.scanId,
      ]),
    ).toEqual({ invalidated: 1 });
    expect(
      await first(kit.env.DB, 'SELECT scan_id FROM scan_retention_proofs WHERE scan_id=?', [
        replacement,
      ]),
    ).toBeNull();
  });

  it('seals the original event, scope and key ring before asynchronous verification', async () => {
    const s = await scenario();
    const mutableEvent = structuredClone(s.eventRow);
    const source = { actionId: ACTION };
    const keys = Object.fromEntries(
      Object.entries(kit.env).filter(([name]) => /^KEK_V\d+$/.test(name)),
    );
    const pending = prepareScanRetentionProof(keys, mutableEvent, `s:${s.scanner.id}`, source);
    mutableEvent.data = '{}';
    mutableEvent.pass_id = 'changed-pass';
    source.actionId = 'changed-action';
    for (const name of Object.keys(keys)) keys[name] = btoa('z'.repeat(32));
    const prepared = await pending;
    expect(prepared.event).toEqual(s.eventRow);
    expect(prepared.scan.actionId).toBe(ACTION);
    expect(await verifyScanRetentionProof(kit.env, prepared.proof, prepared.scan)).toBe(true);
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.proof)).toBe(true);
    expect(Object.isFrozen(prepared.event)).toBe(true);

    const input = { id: s.pass.id, orgId: s.pass.orgId, mode: s.pass.mode };
    const expected = await prepareScanRetentionDelete(kit.env, input);
    const deleteKeys = Object.fromEntries(
      Object.entries(kit.env).filter(([name]) => /^KEK_V\d+$/.test(name)),
    );
    const deleting = prepareScanRetentionDelete(deleteKeys, input);
    input.id = 'changed-pass';
    input.orgId = 'changed-org';
    input.mode = input.mode === 'live' ? 'test' : 'live';
    for (const name of Object.keys(deleteKeys)) deleteKeys[name] = btoa('z'.repeat(32));
    expect(await deleting).toEqual(expected);
  });

  it('keeps raw source values out of packed JSON and marks them as ephemeral scalars', async () => {
    const s = await scenario();
    const prepared = await prepareScanRetentionProof(kit.env, s.eventRow, `s:${s.scanner.id}`, {
      actionId: ACTION,
    });
    const fence = retentionProofCurrentPredicate(prepared);
    const packed = fence.params[0];
    if (typeof packed !== 'string') throw new Error('Missing packed safe snapshot');
    for (const secret of [s.pass.id, ACTION, s.scanner.id, s.eventRow.data])
      expect(packed).not.toContain(secret);
    for (const value of [s.pass.id, ACTION, s.scanner.id, s.eventRow.data])
      expect(fence.params).toContain(value);
    expect(fence.sql).toContain('?/* scan-ephemeral-pass-id */');
    expect(fence.sql).toContain('?/* scan-ephemeral-action-id */');
    expect(fence.sql).toContain('?/* scan-ephemeral-event-json */');
    expect(await first(kit.env.DB, `SELECT 1 AS valid WHERE ${fence.sql}`, fence.params)).toEqual({
      valid: 1,
    });
  });

  it('explains the bound proof in its real insert and composed action output', async () => {
    const real = kit.env.DB;
    const captured: { sql: string; values: SqlValue[] }[] = [];
    const db = new Proxy(real, {
      get(target, prop) {
        if (prop === 'prepare')
          return (sql: string) => {
            const prepared = target.prepare(sql);
            if (!sql.includes('scan_retention_proofs') || !sql.includes('duplicate.data'))
              return prepared;
            return new Proxy(prepared, {
              get(statement, member) {
                if (member === 'bind')
                  return (...values: SqlValue[]) => {
                    captured.push({ sql, values });
                    return statement.bind(...values);
                  };
                const value = Reflect.get(statement, member, statement);
                return typeof value === 'function' ? value.bind(statement) : value;
              },
            });
          };
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    Object.assign(kit.env, { DB: db });
    const s = await scenario().finally(() => {
      Object.assign(kit.env, { DB: real });
    });
    const signed = await prepareScanRetentionProof(kit.env, s.eventRow, `s:${s.scanner.id}`, {
      actionId: ACTION,
    });
    const fence = retentionProofCurrentPredicate(signed);
    expect(scanSecretSlots(fence.sql, fence.params.length)?.map((slot) => slot.label)).toEqual([
      null,
      'pass-id',
      'action-id',
      'scan-actor',
      'actor-key',
      'event-actor',
      'event-json',
      'scanner-id',
      'staff-id',
      'approver-id',
    ]);
    // The commit carries one conditional ledger insert per possible outcome and the grant composes
    // each into its batch; exactly one raw insert binds the committed event's proof.
    const writes = captured.filter(({ sql }) => sql.includes('INSERT INTO scan_retention_proofs'));
    expect(
      writes.filter(({ values }) => JSON.stringify(values) === JSON.stringify(fence.params)),
    ).toHaveLength(1);
    await stmt(real, `EXPLAIN SELECT (${fence.sql})`, fence.params).all();
    for (const { sql, values } of captured) {
      expect(scanSecretSlots(sql, values.length)).not.toBeNull();
      await stmt(real, `EXPLAIN ${sql}`, values).all();
    }
  });

  it('matches signed source in both fences and stored proof fields on read', async () => {
    const s = await scenario();
    const signed = await prepareScanRetentionProof(kit.env, s.eventRow, `s:${s.scanner.id}`, {
      actionId: ACTION,
    });
    const mutations: {
      section: 'scan' | 'event' | 'proof';
      field: string;
      prepared: PreparedScanRetentionProof;
    }[] = [];
    for (const section of ['scan', 'event', 'proof'] as const) {
      for (const [field, value] of Object.entries(signed[section])) {
        if (section === 'proof' && (field === 'excluded' || field === 'invalidated')) continue;
        const changed =
          value === null
            ? 'changed'
            : typeof value === 'boolean'
              ? !value
              : typeof value === 'number'
                ? value + 1
                : `${value}-changed`;
        mutations.push({
          section,
          field,
          prepared: { ...signed, [section]: { ...signed[section], [field]: changed } },
        });
      }
    }
    const db = kit.env.DB;
    const predicates = [signed, ...mutations.map(({ prepared }) => prepared)].map(
      retentionProofCurrentPredicate,
    );
    const reads = await db.batch(
      predicates.map(({ sql, params }) => stmt(db, `SELECT (${sql}) AS valid`, params)),
    );
    expect(reads[0]?.results?.[0]).toEqual({ valid: 1 });
    for (const [index, mutation] of mutations.entries())
      expect(reads[index + 1]?.results?.[0], `${mutation.section}.${mutation.field}`).toEqual({
        valid: 0,
      });

    const sources = mutations.filter(({ section }) => section !== 'proof');
    const counter = `retention-fence:${s.scanId}`;
    const writes = await db.batch([
      stmt(db, 'INSERT INTO counters (key,window_start,count) VALUES (?,0,0)', [counter]),
      ...sources.flatMap(({ prepared }) => [
        retentionProofIfRecordedStmt(db, prepared),
        stmt(db, 'UPDATE counters SET count=count+1 WHERE key=?', [counter]),
      ]),
      stmt(db, 'UPDATE counters SET count=count WHERE key=? AND 0', [counter]),
      retentionProofIfRecordedStmt(db, signed),
      stmt(db, 'DELETE FROM counters WHERE key=?', [counter]),
    ]);
    for (const [index, mutation] of sources.entries())
      expect(writes[1 + index * 2]?.meta.changes, `${mutation.section}.${mutation.field}`).toBe(0);
    expect(writes[2 + sources.length * 2]?.meta.changes).toBe(0);
  });

  it('requires the exact non-null gate and presence snapshots', async () => {
    const template = await kit.scanTemplate('Retention with presence', {
      actions: [{ id: ACTION, label: 'Entry', kind: 'check_in', repeat: 'always' }],
    });
    const event = await kit.event({ templateIds: [template] });
    const scanner = await kit.scanner({ eventId: event.id });
    const pass = await kit.scanPass(template);
    const result = await transition(scanner.headers, pass);
    expect(result.kind).toBe('ok');
    const eventRow = await first<EventRow>(
      kit.env.DB,
      "SELECT * FROM pass_events WHERE pass_id=? AND kind='scan.checked_in'",
      [pass.id],
    );
    if (!eventRow) throw new Error('Missing signed event');
    const signed = await prepareScanRetentionProof(kit.env, eventRow, `s:${scanner.id}`, {
      actionId: ACTION,
    });
    expect(signed.proof.gateSnapshot).not.toBeNull();
    expect(signed.proof.presenceSnapshot).not.toBeNull();
    const current = retentionProofCurrentPredicate(signed);
    expect(await first(kit.env.DB, `SELECT (${current.sql}) AS valid`, current.params)).toEqual({
      valid: 1,
    });
    for (const [field, value] of [
      ['gateSnapshot', signed.proof.gateSnapshot],
      ['presenceSnapshot', signed.proof.presenceSnapshot],
    ] as const) {
      for (const replacement of [null, `${value}-changed`]) {
        const fence = retentionProofCurrentPredicate({
          ...signed,
          proof: { ...signed.proof, [field]: replacement },
        });
        expect(await first(kit.env.DB, `SELECT (${fence.sql}) AS valid`, fence.params)).toEqual({
          valid: 0,
        });
      }
    }
  });

  it.each(['quarantine exclusion', 'duplicate ledger linkage'] as const)(
    'rejects a %s in both insert and current fences',
    async (change) => {
      const s = await scenario();
      const signed = await prepareScanRetentionProof(kit.env, s.eventRow, `s:${s.scanner.id}`, {
        actionId: ACTION,
      });
      const db = kit.env.DB;
      const mutation =
        change === 'quarantine exclusion'
          ? stmt(db, 'INSERT INTO scan_quarantine_exclusions (scan_id) VALUES (?) RETURNING 1', [
              s.scanId,
            ])
          : stmt(
              db,
              `INSERT INTO pass_events (id,org_id,pass_id,mode,kind,device,actor_type,actor_id,data,at)
              SELECT ?,org_id,pass_id,mode,kind,device,actor_type,actor_id,data,at
              FROM pass_events WHERE id=? RETURNING 1`,
              [kit.fx.ids.id(), s.eventRow.id],
            );
      const fence = retentionProofCurrentPredicate(signed);
      const results = await db.batch([
        mutation,
        retentionProofIfRecordedStmt(db, signed),
        stmt(db, `SELECT (${fence.sql}) AS valid`, fence.params),
      ]);
      // meta.changes also counts the trigger that invalidates the proof; RETURNING counts the row.
      expect(results[0]?.results).toHaveLength(1);
      expect(results[1]?.meta.changes).toBe(0);
      expect(results[2]?.results?.[0]).toEqual({ valid: 0 });
    },
  );

  it('authenticates both the completed action and a held-gate receipt', async () => {
    const s = await scenario();
    const response = await kit.post(s.scanner.headers, '/actions', {
      ...s.request,
      idempotencyKey: key(),
    });
    const held = (await response.json()) as ScanOutcome;
    expect(held).toMatchObject({ kind: 'heads_up', reason: 'already_done' });
    if (!held.scanId) throw new Error('Missing held scan ID');
    const proofs = await all<{ scan_id: string; pass_ref: string }>(
      kit.env.DB,
      'SELECT scan_id,pass_ref FROM scan_retention_proofs WHERE scan_id IN (?,?)',
      [s.scanId, held.scanId],
    );
    expect(proofs).toHaveLength(2);
    expect(proofs[0]?.pass_ref).toBe(proofs[1]?.pass_ref);
    await hardDelete(s.pass);
    const verified = await readVerifiedScanRetentionProofs(
      kit.env.DB,
      kit.env,
      { orgId: kit.org.id, mode: 'live' },
      [s.scanId, held.scanId],
    );
    expect([...verified.keys()].sort()).toEqual([s.scanId, held.scanId].sort());
    expect(await scopedCount(kit.org.id, s.event.id)).toBe(1);
  });

  it('omits old null-pass scans with no signed source', async () => {
    const id = kit.fx.ids.id();
    await run(
      kit.env.DB,
      `INSERT INTO scans
      (id,org_id,mode,pass_id,template_id,actor_type,actor_id,actor_key,idempotency_key,request_hash,method,state,outcome,at)
      VALUES (?,?,?,NULL,?,'user',?,?,?,?,'camera','done','ok',?)`,
      [id, kit.org.id, 'live', templateId, 'user', 'u:user', id, id, kit.clock.now()],
    );
    expect(
      await all(
        kit.env.DB,
        `SELECT s.id FROM scans s WHERE s.id=? AND ${scanRetentionCandidateSql('s')}`,
        [id],
      ),
    ).toEqual([]);
    expect(
      (await readVerifiedScanRetentionProofs(kit.env.DB, kit.env, { mode: 'live' }, [id])).size,
    ).toBe(0);
  });

  it('invalidates a duplicate original event in the same pass scope', async () => {
    const s = await scenario();
    await run(
      kit.env.DB,
      `INSERT INTO pass_events (id,org_id,pass_id,mode,kind,device,actor_type,actor_id,data,at)
      SELECT ?,org_id,pass_id,mode,kind,device,actor_type,actor_id,data,at FROM pass_events WHERE id=?`,
      [kit.fx.ids.id(), s.eventRow.id],
    );
    expect(
      await first(
        kit.env.DB,
        'SELECT excluded,invalidated FROM scan_retention_proofs WHERE scan_id=?',
        [s.scanId],
      ),
    ).toEqual({ excluded: 0, invalidated: 1 });
    await hardDelete(s.pass);
    expect(
      (await readVerifiedScanRetentionProofs(kit.env.DB, kit.env, { mode: 'live' }, [s.scanId]))
        .size,
    ).toBe(0);
    expect(await scopedCount(kit.org.id, s.event.id)).toBe(0);
  });

  it('blocks an unreserved pass scope change and permanently invalidates a mismatched scan scope', async () => {
    const s = await scenario();
    await expect(
      run(kit.env.DB, "UPDATE passes SET mode='test' WHERE id=?", [s.pass.id]),
    ).rejects.toThrow('credential transfer required');
    expect(
      await first(
        kit.env.DB,
        'SELECT excluded,invalidated FROM scan_retention_proofs WHERE scan_id=?',
        [s.scanId],
      ),
    ).toEqual({ excluded: 0, invalidated: 0 });
    await run(kit.env.DB, "UPDATE scans SET mode='test' WHERE id=?", [s.scanId]);
    expect(
      await first(
        kit.env.DB,
        'SELECT excluded,invalidated FROM scan_retention_proofs WHERE scan_id=?',
        [s.scanId],
      ),
    ).toEqual({ excluded: 0, invalidated: 1 });
    await run(kit.env.DB, "UPDATE scans SET mode='live' WHERE id=?", [s.scanId]);
    await run(kit.env.DB, 'DELETE FROM passes WHERE id=?', [s.pass.id]);
    expect(
      (await readVerifiedScanRetentionProofs(kit.env.DB, kit.env, { mode: 'live' }, [s.scanId]))
        .size,
    ).toBe(0);
    expect(
      await all(
        kit.env.DB,
        `SELECT s.id FROM scans s WHERE s.id=? AND ${scanRetentionCandidateSql('s')}`,
        [s.scanId],
      ),
    ).toEqual([]);
  });

  it('rejects tampered, missing, cross-scope and ambiguous evidence without restoring it after delete', async () => {
    const s = await scenario();
    const signed = await prepareScanRetentionProof(kit.env, s.eventRow, `s:${s.scanner.id}`, {
      actionId: ACTION,
    });
    const fence = retentionProofCurrentPredicate(signed);
    expect(await first(kit.env.DB, `SELECT 1 AS valid WHERE ${fence.sql}`, fence.params)).toEqual({
      valid: 1,
    });
    expect(
      await verifyScanRetentionProof(
        kit.env,
        { ...signed.proof, mac: '0'.repeat(64) },
        signed.scan,
      ),
    ).toBe(false);
    expect(
      await verifyScanRetentionProof(kit.env, { ...signed.proof, orgId: 'foreign' }, signed.scan),
    ).toBe(false);
    expect(
      await verifyScanRetentionProof(kit.env, { ...signed.proof, mode: 'test' }, signed.scan),
    ).toBe(false);
    expect(
      await verifyScanRetentionProof(
        kit.env,
        { ...signed.proof, scanDigest: 'not-a-digest' },
        signed.scan,
      ),
    ).toBe(false);
    expect(
      await verifyScanRetentionProof(kit.env, { ...signed.proof, gateSnapshot: '{}' }, signed.scan),
    ).toBe(false);
    expect(await verifyScanRetentionProof(kit.env, null, signed.scan)).toBe(false);
    await expect(
      prepareScanRetentionProof(kit.env, s.eventRow, `s:${s.scanner.id}`, {
        actionId: 'different',
      }),
    ).rejects.toBeInstanceOf(InvalidScanRetentionProof);
    await expect(
      run(kit.env.DB, 'UPDATE scan_retention_proofs SET mac=? WHERE scan_id=?', [
        '0'.repeat(64),
        s.scanId,
      ]),
    ).rejects.toThrow();
    await expect(
      run(kit.env.DB, 'DELETE FROM scan_retention_proofs WHERE scan_id=?', [s.scanId]),
    ).rejects.toThrow();
    await run(kit.env.DB, "UPDATE scans SET reason='altered' WHERE id=?", [s.scanId]);
    expect(
      await first(kit.env.DB, `SELECT 1 AS valid WHERE ${fence.sql}`, fence.params),
    ).toBeNull();
    expect(
      await first(
        kit.env.DB,
        'SELECT excluded,invalidated FROM scan_retention_proofs WHERE scan_id=?',
        [s.scanId],
      ),
    ).toEqual({ excluded: 0, invalidated: 1 });
    await run(kit.env.DB, 'DELETE FROM passes WHERE id=?', [s.pass.id]);
    expect(
      (await readVerifiedScanRetentionProofs(kit.env.DB, kit.env, { mode: 'live' }, [s.scanId]))
        .size,
    ).toBe(0);
    expect(
      await all(
        kit.env.DB,
        `SELECT s.id FROM scans s WHERE s.id=? AND ${scanRetentionCandidateSql('s')}`,
        [s.scanId],
      ),
    ).toEqual([]);
  });

  registerRetentionOccupancyTests();
});
