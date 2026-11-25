import { beforeAll, describe, expect, it } from 'vitest';
import { makePass } from '../../../../../test/helpers/index.ts';
import type { ScanZone } from '../../../../shared/contracts/scan-access.ts';
import { all, first, run } from '../../../platform/db.ts';
import { createJobContext } from '../../../platform/service-context.ts';
import { sweepClass } from '../../retention/sweep.ts';
import {
  InvalidScanRetentionProof,
  prepareSystemScanRetentionProof,
} from '../scan-retention-proof.ts';
import {
  deletePass,
  proofCount,
  retained,
  verifyStored,
} from '../scan-retention-system-test-fixtures.ts';
import { scanningSessionsFixture } from '../scanning-sessions-test-fixtures.ts';
import { exitGrant, type OutCause } from './auto-exit.ts';
import { autoTapOut, DUE_BATCH } from './jobs.ts';
import type { DueRow } from './repo-reads.ts';
import { exitAsGiven } from './rules.ts';
import { readUnsigned } from './unsigned.ts';

const fixture = scanningSessionsFixture();
beforeAll(fixture.setup);

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
let seq = 0;
const db = () => fixture.kit.env.DB;
const ctx = () => createJobContext(fixture.kit.env, 'test', { clock: fixture.kit.clock });

async function zone(extra: Record<string, unknown> = {}): Promise<ScanZone> {
  const key = `proof${(seq++).toString(36)}`;
  const res = await fixture.call('POST', '/scan-zones', {
    orgId: fixture.kit.org.id,
    key,
    name: `Proof ${key}`,
    occupancy: 'track',
    ...extra,
  });
  expect(res.status).toBe(201);
  return (await res.json()) as ScanZone;
}

/** A pass that has been inside `z` since `enteredAt`. */
async function inside(z: ScanZone, enteredAt: number, due: number) {
  const pass = await makePass(fixture.kit.fx, {
    orgId: fixture.kit.org.id,
    template: fixture.kit.template,
  });
  await run(
    db(),
    `INSERT INTO scan_presence (pass_id, org_id, scope, state, tracking, entered_at, first_at, last_entry_at,
       last_scan_id, due_at) VALUES (?, ?, ?, 'in', 1, ?, ?, ?, ?, ?)`,
    [
      pass.id,
      fixture.kit.org.id,
      `zone:${z.id}`,
      enteredAt,
      enteredAt,
      enteredAt,
      `seed-${seq++}`,
      due,
    ],
  );
  return pass;
}

const dueRow = async (passId: string, z: ScanZone) => {
  const r = await first<DueRow>(
    db(),
    `SELECT x.pass_id, x.org_id, x.mode, x.scope, x.entered_at, x.last_entry_at, x.last_scan_id, x.due_at, p.template_id
     FROM scan_presence x JOIN passes p ON p.id = x.pass_id WHERE x.pass_id = ? AND x.scope = ?`,
    [passId, `zone:${z.id}`],
  );
  if (!r) throw new Error('no row');
  return r;
};
const autoScan = async (passId: string) => {
  const r = await first<{ id: string }>(
    db(),
    "SELECT id FROM scans WHERE actor_key = 'sys:occupancy' AND pass_id = ? AND state = 'done'",
    [passId],
  );
  if (!r) throw new Error('no auto scan');
  return r.id;
};
const exitWith = async (p: { id: string }, z: ScanZone, cause: OutCause, at: number) => {
  const row = await dueRow(p.id, z);
  await (await exitGrant(ctx(), row, exitAsGiven([], row.scope), cause, at)).commit();
};

describe('auto exit proof', () => {
  it('signs the exit in the batch that writes it, for each cause', async () => {
    const now = fixture.kit.clock.now();
    for (const cause of ['stay', 'clear', 'zone'] as const) {
      const z = await zone({ maxStayMinutes: 60 });
      const p = await inside(z, now - 2 * HOUR, now - HOUR);
      await exitWith(p, z, cause, now);
      const scanId = await autoScan(p.id);
      const proof = await first<Record<string, unknown>>(
        db(),
        'SELECT * FROM scan_retention_proofs WHERE scan_id = ?',
        [scanId],
      );
      const event = await first<{ id: string; kind: string; data: string }>(
        db(),
        'SELECT id, kind, data FROM pass_events WHERE pass_id = ?',
        [p.id],
      );
      expect(proof).toMatchObject({
        ledger_event_id: event?.id,
        gate_snapshot: null,
        presence_snapshot: null,
        excluded: 0,
        invalidated: 0,
      });
      expect(JSON.parse(event?.data ?? '{}')).toMatchObject({
        direction: 'out',
        exit: cause,
        zoneId: z.id,
      });
      expect(JSON.parse(event?.data ?? '{}').authority).toEqual({
        kind: 'system',
        job: 'scan.occupancy',
        cause,
      });
      expect(await verifyStored(db(), fixture.kit.env, scanId)).toBe(true);
    }
  });

  it('is retained as passless evidence after the pass is deleted', async () => {
    const now = fixture.kit.clock.now();
    const z = await zone({ maxStayMinutes: 60 });
    const p = await inside(z, now - 2 * HOUR, now - HOUR);
    await autoTapOut(ctx());
    const scanId = await autoScan(p.id);
    const scope = { orgId: fixture.kit.org.id, mode: 'live' as const };
    expect(await retained(db(), fixture.kit.env, scope, scanId)).toBe(false);
    await deletePass(db(), fixture.kit.env, { id: p.id, orgId: p.orgId, mode: 'live' });
    expect(await first(db(), 'SELECT pass_id FROM scans WHERE id = ?', [scanId])).toEqual({
      pass_id: null,
    });
    expect(await retained(db(), fixture.kit.env, scope, scanId)).toBe(true);
    // The cause is attested: a rewritten one no longer verifies.
    await run(db(), "UPDATE scans SET out_cause = 'zone' WHERE id = ?", [scanId]);
    expect(await retained(db(), fixture.kit.env, scope, scanId)).toBe(false);
  });

  it('fails when the scan or the proof is tampered', async () => {
    const now = fixture.kit.clock.now();
    const z = await zone({ maxStayMinutes: 60 });
    const p = await inside(z, now - 2 * HOUR, now - HOUR);
    await exitWith(p, z, 'stay', now);
    const scanId = await autoScan(p.id);
    const env = fixture.kit.env;
    const zeros = '0'.repeat(64);
    expect(await verifyStored(db(), env, scanId)).toBe(true);
    for (const tamper of [
      { scan: { outCause: 'clear' } },
      { scan: { outCause: undefined } },
      { scan: { actorType: 'user' } },
      { scan: { actorId: 'someone' } },
      { scan: { at: now + 1 } },
      { scan: { direction: 'in' } },
      { scan: { undoes: 'x' } },
      { proof: { mac: zeros } },
      { proof: { passRef: zeros } },
      { proof: { eventDigest: zeros } },
      { proof: { scanDigest: zeros } },
      { proof: { gateSnapshot: '{}' } },
    ])
      expect(await verifyStored(db(), env, scanId, tamper), JSON.stringify(tamper)).toBe(false);
  });

  it('writes one proof when the exit is retried, raced or run twice', async () => {
    const now = fixture.kit.clock.now();
    const z = await zone({ maxStayMinutes: 60 });
    const p = await inside(z, now - 2 * HOUR, now - HOUR);
    const row = await dueRow(p.id, z);
    const plan = exitAsGiven([], row.scope);
    await (await exitGrant(ctx(), row, plan, 'stay', now)).commit();
    const scanId = await autoScan(p.id);
    // The exit is lost but the claim stays: the retry must not exit or sign again.
    await run(db(), "UPDATE scan_presence SET state = 'in', last_scan_id = ? WHERE pass_id = ?", [
      row.last_scan_id,
      p.id,
    ]);
    await (await exitGrant(ctx(), row, plan, 'stay', now)).commit();
    await autoTapOut(ctx());
    expect(await proofCount(db(), scanId)).toBe(1);
    expect(
      await all(
        db(),
        'SELECT 1 FROM scan_retention_proofs r JOIN scans s ON s.id = r.scan_id WHERE s.pass_id = ?',
        [p.id],
      ),
    ).toHaveLength(1);
    expect(await all(db(), 'SELECT 1 FROM pass_events WHERE pass_id = ?', [p.id])).toHaveLength(1);
  });

  it('leaves no scan, event or proof when a tap got there first', async () => {
    const now = fixture.kit.clock.now();
    const z = await zone({ maxStayMinutes: 60 });
    const p = await inside(z, now - 2 * HOUR, now - HOUR);
    const row = await dueRow(p.id, z);
    await run(
      db(),
      "UPDATE scan_presence SET last_scan_id = 'tap', last_entry_at = ? WHERE pass_id = ?",
      [now, p.id],
    );
    await (await exitGrant(ctx(), row, exitAsGiven([], row.scope), 'stay', now)).commit();
    expect(
      await all(
        db(),
        'SELECT 1 FROM scan_retention_proofs r JOIN scans s ON s.id = r.scan_id WHERE s.pass_id = ?',
        [p.id],
      ),
    ).toEqual([]);
    expect(await all(db(), 'SELECT 1 FROM pass_events WHERE pass_id = ?', [p.id])).toEqual([]);
  });

  it('commits nothing when the proof insert fails: no exit, scan or event', async () => {
    const now = fixture.kit.clock.now();
    const z = await zone({ maxStayMinutes: 60 });
    const p = await inside(z, now - 2 * HOUR, now - HOUR);
    await run(
      db(),
      "CREATE TRIGGER auto_proof_refused BEFORE INSERT ON scan_retention_proofs BEGIN SELECT RAISE(ABORT, 'proof refused'); END",
    );
    try {
      await expect(exitWith(p, z, 'stay', now)).rejects.toThrow();
    } finally {
      await run(db(), 'DROP TRIGGER auto_proof_refused');
    }
    expect(await first(db(), 'SELECT state FROM scan_presence WHERE pass_id = ?', [p.id])).toEqual({
      state: 'in',
    });
    expect(
      await all(db(), 'SELECT 1 FROM scans WHERE pass_id = ? OR actor_key = ?', [p.id, 'x']),
    ).toEqual([]);
    expect(
      await all(
        db(),
        "SELECT 1 FROM scans WHERE state = 'pending' AND actor_key = 'sys:occupancy'",
      ),
    ).toEqual([]);
    expect(await all(db(), 'SELECT 1 FROM pass_events WHERE pass_id = ?', [p.id])).toEqual([]);
  });

  it('aborts the batch when the written row drifts from the facts the proof signs', async () => {
    const now = fixture.kit.clock.now();
    const z = await zone({ maxStayMinutes: 60 });
    const p = await inside(z, now - 2 * HOUR, now - HOUR);
    await run(
      db(),
      "CREATE TRIGGER auto_drift AFTER UPDATE ON scans WHEN NEW.actor_key = 'sys:occupancy' AND NEW.state = 'done' AND NEW.out_cause = 'stay' BEGIN UPDATE scans SET out_cause = 'zone' WHERE id = NEW.id; END",
    );
    try {
      await expect(exitWith(p, z, 'stay', now)).rejects.toMatchObject({
        code: 'SCAN_PROOF_MISMATCH',
        status: 500,
      });
    } finally {
      await run(db(), 'DROP TRIGGER auto_drift');
    }
    expect(await first(db(), 'SELECT state FROM scan_presence WHERE pass_id = ?', [p.id])).toEqual({
      state: 'in',
    });
    expect(await all(db(), 'SELECT 1 FROM pass_events WHERE pass_id = ?', [p.id])).toEqual([]);
    expect(await autoScan(p.id).catch(() => null)).toBeNull();
  });

  it('is purged with its scan by the sweep and kept while the scan is', async () => {
    const clock = fixture.kit.clock;
    const present = clock.now();
    const z = await zone({ maxStayMinutes: 60 });
    const old = await inside(z, present - 2 * HOUR, present - HOUR);
    const oldAt = present - 800 * DAY;
    clock.set(oldAt);
    await exitWith(old, z, 'stay', oldAt);
    const oldId = await autoScan(old.id);
    clock.set(present);
    const recent = await inside(z, present - 2 * HOUR, present - HOUR);
    await exitWith(recent, z, 'stay', present);
    const recentId = await autoScan(recent.id);
    expect(await proofCount(db(), oldId)).toBe(1);
    await sweepClass(ctx(), 'scans');
    expect(await proofCount(db(), oldId)).toBe(0);
    expect(await first(db(), 'SELECT 1 FROM scans WHERE id = ?', [oldId])).toBeNull();
    expect(await proofCount(db(), recentId)).toBe(1);
    expect(await verifyStored(db(), fixture.kit.env, recentId)).toBe(true);
  });
});

describe('unsignable rows in the cron', () => {
  const unsigned = async () => [...(await readUnsigned(db())).values()];

  it('backs off 200+ unsignable stays so a signable exit and a recovered row still go', async () => {
    const clock = fixture.kit.clock;
    const now = clock.now();
    const z = await zone({ maxStayMinutes: 60 });
    const bad = new Set<string>();
    for (let i = 0; i < DUE_BATCH + 5; i++) {
      const p = await inside(z, now - 5 * HOUR, now - 4 * HOUR - i);
      bad.add(p.id);
    }
    const good = await inside(z, now - 2 * HOUR, now - HOUR);
    const calls: string[] = [];
    const tried = () => new Set(calls).size;
    const flaky: typeof exitGrant = (c, row, plan, cause, at) => {
      if (bad.has(row.pass_id)) {
        calls.push(row.pass_id);
        throw new InvalidScanRetentionProof();
      }
      return exitGrant(c, row, plan, cause, at);
    };
    const state = async (id: string) =>
      (
        await first<{ state: string }>(db(), 'SELECT state FROM scan_presence WHERE pass_id = ?', [
          id,
        ])
      )?.state;

    await autoTapOut(ctx(), flaky);
    expect(await state(good.id)).toBe('out');
    expect(tried()).toBe(bad.size);
    expect((await unsigned()).length).toBe(bad.size);
    expect(await unsigned()).toEqual(
      expect.arrayContaining([{ failures: 1, retryAt: now + 5 * 60_000 }]),
    );

    // Within the delay nobody is retried; a retry after it fails again with a longer delay.
    calls.length = 0;
    await autoTapOut(ctx(), flaky);
    expect(calls).toEqual([]);
    clock.set(now + 6 * 60_000);
    await autoTapOut(ctx(), flaky);
    expect(tried()).toBe(bad.size);
    expect((await unsigned())[0]).toMatchObject({ failures: 2 });

    // One row recovers: it exits and leaves the memory; the rest stay inside.
    const [fixed] = [...bad];
    bad.delete(fixed as string);
    clock.set(now + 6 * 60_000 + 11 * 60_000);
    await autoTapOut(ctx(), flaky);
    expect(await state(fixed as string)).toBe('out');
    expect((await unsigned()).length).toBe(bad.size);
    expect(await state([...bad][0] as string)).toBe('in');
    clock.set(now);
  }, 180_000);
});

describe('prepareSystemScanRetentionProof', () => {
  const env = () => fixture.kit.env;
  const scan = {
    id: '019b796d-d600-7009-81b4-897a4bf85ee0',
    orgId: 'o',
    mode: 'live' as const,
    templateId: 't',
    scannerId: null,
    eventId: null,
    actorType: 'system' as const,
    actorId: 'occupancy',
    actorKey: 'sys:occupancy',
    staffId: null,
    approvedBy: null,
    method: 'auto' as const,
    state: 'done' as const,
    outcome: 'ok' as const,
    reason: null,
    actionId: null,
    actionKind: 'check_in',
    direction: 'out' as const,
    passVersion: null,
    presenceScope: 'zone:z',
    at: 5,
    undoes: null,
    override: false,
    outCause: 'stay' as const,
  };
  const event = (over: Record<string, unknown> = {}, row: Record<string, unknown> = {}) => ({
    id: 'e1',
    org_id: 'o',
    pass_id: 'p',
    mode: 'live' as const,
    kind: 'scan.checked_out' as const,
    device: null,
    actor_type: 'system' as const,
    actor_id: 'occupancy',
    data: JSON.stringify({
      scanId: scan.id,
      outcome: 'ok',
      method: 'auto',
      eventId: null,
      scannerId: null,
      staffId: null,
      outCause: 'stay',
      authority: { kind: 'system', job: 'scan.occupancy', cause: 'stay' },
      ...over,
    }),
    at: 5,
    ...row,
  });

  it('signs a matching pair and refuses one that disagrees', async () => {
    await expect(prepareSystemScanRetentionProof(env(), event(), scan)).resolves.toMatchObject({
      proof: { scanId: scan.id, gateSnapshot: null },
    });
    const bad = [
      prepareSystemScanRetentionProof(env(), event({ authority: undefined }), scan),
      prepareSystemScanRetentionProof(
        env(),
        event({ authority: { kind: 'console', purpose: 'org_mode.scan.check_in' } }),
        scan,
      ),
      prepareSystemScanRetentionProof(
        env(),
        event({ authority: { kind: 'system', job: 'scan.occupancy', cause: 'zone' } }),
        scan,
      ),
      prepareSystemScanRetentionProof(env(), event({ outCause: 'zone' }), scan),
      prepareSystemScanRetentionProof(env(), event({ scanId: 'other' }), scan),
      prepareSystemScanRetentionProof(env(), event({}, { kind: 'scan.checked_in' }), scan),
      prepareSystemScanRetentionProof(env(), event({}, { actor_id: 'x' }), scan),
      prepareSystemScanRetentionProof(env(), event({}, { org_id: 'other' }), scan),
      prepareSystemScanRetentionProof(env(), event({}, { data: `${event().data} ` }), scan),
      prepareSystemScanRetentionProof(env(), event(), { ...scan, direction: 'in' }),
      prepareSystemScanRetentionProof(env(), event(), { ...scan, outCause: 'desk' }),
      prepareSystemScanRetentionProof(env(), event(), {
        ...scan,
        actorType: 'user',
        outCause: 'stay',
      }),
    ];
    for (const attempt of bad)
      await expect(attempt).rejects.toBeInstanceOf(InvalidScanRetentionProof);
  });
});
