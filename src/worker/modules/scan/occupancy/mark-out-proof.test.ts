import { beforeAll, describe, expect, it } from 'vitest';
import { all, first, run } from '../../../platform/db.ts';
import { CHECK_IN } from '../act-test-fixtures.ts';
import {
  deletePass,
  proofCount,
  retained,
  verifyStored,
} from '../scan-retention-system-test-fixtures.ts';
import { scanningSessionsFixture } from '../scanning-sessions-test-fixtures.ts';
import { key } from '../test-kit.ts';
import { personInside, presenceOf, station, trackedZone, useKit } from './whos-in-test-fixtures.ts';

const fixture = scanningSessionsFixture();
let tpl: string;
beforeAll(async () => {
  await fixture.setup();
  useKit(fixture.kit);
  tpl = await fixture.kit.scanTemplate('Gym', { actions: [CHECK_IN] });
});
const db = () => fixture.kit.env.DB;
const env = () => fixture.kit.env;

const deskMarkOut = (headers: Record<string, string>, passId: string, place: string, k = key()) =>
  fixture.kit.post(headers, '/mark-out', { idempotencyKey: k, passId, place });
const scanOf = async (passId: string) => {
  const r = await first<{ id: string }>(
    db(),
    "SELECT id FROM scans WHERE pass_id = ? AND out_cause = 'desk'",
    [passId],
  );
  if (!r) throw new Error('no mark-out scan');
  return r.id;
};

describe('desk mark-out proof', () => {
  it('signs the exit in the batch that writes it, naming the console authority', async () => {
    const pool = await trackedZone();
    const place = `zone:${pool.id}`;
    const p = await personInside(tpl, 'Forgot Out', [place]);
    const s = await station([tpl], [pool.id]);
    expect((await deskMarkOut(s.headers, p.id, place)).status).toBe(200);
    const scanId = await scanOf(p.id);
    const event = await first<{ id: string; kind: string; data: string }>(
      db(),
      "SELECT id, kind, data FROM pass_events WHERE pass_id = ? AND kind = 'scan.checked_out'",
      [p.id],
    );
    expect(event?.kind).toBe('scan.checked_out');
    expect(JSON.parse(event?.data ?? '{}').authority).toEqual({
      kind: 'device',
      purpose: 'org_mode.scan.check_in',
    });
    expect(
      await first(
        db(),
        'SELECT ledger_event_id, gate_snapshot FROM scan_retention_proofs WHERE scan_id = ?',
        [scanId],
      ),
    ).toEqual({ ledger_event_id: event?.id, gate_snapshot: null });
    expect(await verifyStored(db(), env(), scanId)).toBe(true);
  });

  it('signs a console user and a signed-in desk staff member as who marked out', async () => {
    const gym = await trackedZone();
    const place = `zone:${gym.id}`;
    const a = await personInside(tpl, 'By Console', [place]);
    const res = await fixture.call('POST', `/scan-zones/${gym.id}/mark-out`, {
      passId: a.id,
      place,
    });
    expect(res.status).toBe(204);
    const consoleScan = await scanOf(a.id);
    const consoleEvent = await first<{ data: string }>(
      db(),
      "SELECT data FROM pass_events WHERE pass_id = ? AND kind = 'scan.checked_out'",
      [a.id],
    );
    expect(JSON.parse(consoleEvent?.data ?? '{}')).toMatchObject({
      direction: 'out',
      exit: 'desk',
      zoneId: gym.id,
    });
    expect(JSON.parse(consoleEvent?.data ?? '{}').authority).toEqual({
      kind: 'console',
      purpose: 'org_mode.scan.mark_out',
    });
    expect(await first(db(), 'SELECT actor_type FROM scans WHERE id = ?', [consoleScan])).toEqual({
      actor_type: 'user',
    });
    expect(await verifyStored(db(), env(), consoleScan)).toBe(true);

    const b = await personInside(tpl, 'By Staff', [place]);
    const s = await station([tpl], [gym.id], {
      deviceRole: 'monitor',
      deskActions: true,
      signedIn: true,
    });
    expect((await deskMarkOut(s.headers, b.id, place)).status).toBe(200);
    const staffScan = await scanOf(b.id);
    expect(
      await first<{ staff_id: string | null }>(db(), 'SELECT staff_id FROM scans WHERE id = ?', [
        staffScan,
      ]),
    ).toEqual({ staff_id: expect.any(String) });
    expect(await verifyStored(db(), env(), staffScan)).toBe(true);
  });

  it('writes one proof for a repeated key and none for a refused second request', async () => {
    const pool = await trackedZone();
    const place = `zone:${pool.id}`;
    const p = await personInside(tpl, 'Twice', [place]);
    const s = await station([tpl], [pool.id]);
    const k = key();
    expect((await deskMarkOut(s.headers, p.id, place, k)).status).toBe(200);
    expect((await deskMarkOut(s.headers, p.id, place, k)).status).toBe(200);
    expect((await deskMarkOut(s.headers, p.id, place)).status).toBe(409);
    const scanId = await scanOf(p.id);
    expect(await proofCount(db(), scanId)).toBe(1);
    expect(
      await all(
        db(),
        'SELECT 1 FROM scan_retention_proofs r JOIN scans s ON s.id = r.scan_id WHERE s.pass_id = ?',
        [p.id],
      ),
    ).toHaveLength(1);
    expect(
      await all(db(), "SELECT 1 FROM pass_events WHERE pass_id = ? AND kind = 'scan.checked_out'", [
        p.id,
      ]),
    ).toHaveLength(1);
  });

  it('commits nothing when the proof insert fails: the exit, scan and event roll back with it', async () => {
    const pool = await trackedZone();
    const place = `zone:${pool.id}`;
    const p = await personInside(tpl, 'Proof Fails', [place]);
    const s = await station([tpl], [pool.id]);
    await run(
      db(),
      "CREATE TRIGGER proof_refused BEFORE INSERT ON scan_retention_proofs BEGIN SELECT RAISE(ABORT, 'proof refused'); END",
    );
    try {
      expect((await deskMarkOut(s.headers, p.id, place)).status).toBeGreaterThanOrEqual(400);
    } finally {
      await run(db(), 'DROP TRIGGER proof_refused');
    }
    expect((await presenceOf(p.id, place))[0]?.state).toBe('in');
    expect(await all(db(), 'SELECT 1 FROM scans WHERE pass_id = ?', [p.id])).toEqual([]);
    expect(
      await all(db(), "SELECT 1 FROM pass_events WHERE pass_id = ? AND kind = 'scan.checked_out'", [
        p.id,
      ]),
    ).toEqual([]);
    expect((await deskMarkOut(s.headers, p.id, place)).status).toBe(200);
  });

  it('aborts the batch when the written row drifts from the facts the proof signs', async () => {
    const pool = await trackedZone();
    const place = `zone:${pool.id}`;
    const p = await personInside(tpl, 'Drift', [place]);
    const s = await station([tpl], [pool.id]);
    await run(
      db(),
      "CREATE TRIGGER mark_out_drift AFTER INSERT ON scans WHEN NEW.out_cause = 'desk' BEGIN UPDATE scans SET out_cause = 'forced' WHERE id = NEW.id; END",
    );
    try {
      const res = await deskMarkOut(s.headers, p.id, place);
      expect(res.status).toBe(500);
      expect(await res.text()).toContain('SCAN_PROOF_MISMATCH');
    } finally {
      await run(db(), 'DROP TRIGGER mark_out_drift');
    }
    expect((await presenceOf(p.id, place))[0]?.state).toBe('in');
    expect(await all(db(), 'SELECT 1 FROM scans WHERE pass_id = ?', [p.id])).toEqual([]);
    expect(
      await all(db(), "SELECT 1 FROM pass_events WHERE pass_id = ? AND kind = 'scan.checked_out'", [
        p.id,
      ]),
    ).toEqual([]);
  });

  it('fails when the scan or the proof is tampered, and is retained after the pass is deleted', async () => {
    const pool = await trackedZone();
    const place = `zone:${pool.id}`;
    const p = await personInside(tpl, 'Tamper', [place]);
    const s = await station([tpl], [pool.id]);
    expect((await deskMarkOut(s.headers, p.id, place)).status).toBe(200);
    const scanId = await scanOf(p.id);
    const zeros = '0'.repeat(64);
    for (const tamper of [
      { scan: { outCause: 'clear' } },
      { scan: { outCause: undefined } },
      { scan: { actorType: 'system' } },
      { scan: { staffId: 'someone' } },
      { scan: { at: 1 } },
      { scan: { presenceScope: 'zone:other' } },
      { proof: { mac: zeros } },
      { proof: { passRef: zeros } },
      { proof: { eventDigest: zeros } },
    ])
      expect(await verifyStored(db(), env(), scanId, tamper), JSON.stringify(tamper)).toBe(false);

    const scope = { orgId: fixture.kit.org.id, mode: 'live' as const };
    await deletePass(db(), env(), { id: p.id, orgId: p.orgId, mode: 'live' });
    expect(await retained(db(), env(), scope, scanId)).toBe(true);
    await run(db(), "UPDATE scans SET out_cause = 'zone' WHERE id = ?", [scanId]);
    expect(await retained(db(), env(), scope, scanId)).toBe(false);
  });
});
