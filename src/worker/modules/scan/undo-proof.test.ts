import { beforeAll, describe, expect, it } from 'vitest';
import { all, first, run } from '../../platform/db.ts';
import { act, kit, out, setupActionFixture, tpl } from './act-test-fixtures.ts';
import {
  deletePass,
  proofCount,
  retained,
  verifyStored,
} from './scan-retention-system-test-fixtures.ts';
import { codeOf, key } from './test-kit.ts';

beforeAll(setupActionFixture);

const ADD = { id: 'add', label: 'Add', kind: 'add', input: 'balance', repeat: 'always' } as const;
const desk = (templateIds: string[]) =>
  kit.scanner({ templateIds, settings: { roleWithoutSignIn: 'desk' } });
const undoScan = (headers: Record<string, string>, scanId: string | null, k = key()) =>
  kit.post(headers, `/scans/${scanId}/undo`, { idempotencyKey: k });
const db = () => kit.env.DB;

/** A check-in by a desk scanner, then its undo. */
async function undone() {
  const s = await desk([tpl]);
  const pass = await kit.scanPass(tpl, {});
  const target = await out(await act(s.headers, codeOf(pass), { actionId: 'check_in' }));
  expect(target.kind).toBe('ok');
  const k = key();
  const res = await undoScan(s.headers, target.scanId, k);
  expect(res.status, await res.clone().text()).toBe(200);
  const result = (await res.json()) as { scanId: string };
  return { s, pass, k, targetId: target.scanId ?? '', scanId: result.scanId };
}

describe('undo proof', () => {
  it('signs the undo in the batch that writes it, naming the undo authority; the target keeps its own', async () => {
    const u = await undone();
    const event = await first<{ id: string; data: string }>(
      db(),
      "SELECT id, data FROM pass_events WHERE pass_id = ? AND kind = 'scan.undone'",
      [u.pass.id],
    );
    expect(JSON.parse(event?.data ?? '{}').authority).toEqual({
      kind: 'undo',
      purpose: 'org_mode.scan.undo',
      undoes: u.targetId,
    });
    expect(
      await first(
        db(),
        'SELECT ledger_event_id, gate_snapshot FROM scan_retention_proofs WHERE scan_id = ?',
        [u.scanId],
      ),
    ).toEqual({ ledger_event_id: event?.id, gate_snapshot: null });
    expect(await verifyStored(db(), kit.env, u.scanId)).toBe(true);
    // The check-in's v1 proof still verifies after its undo.
    expect(await proofCount(db(), u.targetId)).toBe(1);
    expect(await verifyStored(db(), kit.env, u.targetId)).toBe(true);
  });

  it('writes one proof when the undo is repeated', async () => {
    const u = await undone();
    const again = await undoScan(u.s.headers, u.targetId, u.k);
    expect(again.status).toBe(200);
    expect(await proofCount(db(), u.scanId)).toBe(1);
    expect(
      await all(db(), "SELECT 1 FROM pass_events WHERE pass_id = ? AND kind = 'scan.undone'", [
        u.pass.id,
      ]),
    ).toHaveLength(1);
    const other = await undoScan(u.s.headers, u.targetId);
    expect(other.status).toBeGreaterThanOrEqual(400);
    expect(
      await all(
        db(),
        'SELECT 1 FROM scan_retention_proofs r JOIN scans s ON s.id = r.scan_id WHERE s.pass_id = ? AND s.undoes IS NOT NULL',
        [u.pass.id],
      ),
    ).toHaveLength(1);
  });

  it('fails when the scan or the proof is tampered, and is retained after the pass is deleted', async () => {
    const u = await undone();
    const zeros = '0'.repeat(64);
    for (const tamper of [
      { scan: { undoes: null } },
      { scan: { undoes: u.scanId } },
      { scan: { actorId: 'someone' } },
      { scan: { approvedBy: 'someone' } },
      { scan: { at: 1 } },
      { scan: { outCause: 'desk' } },
      { proof: { mac: zeros } },
      { proof: { passRef: zeros } },
      { proof: { eventDigest: zeros } },
      { proof: { presenceSnapshot: '{}' } },
    ])
      expect(await verifyStored(db(), kit.env, u.scanId, tamper), JSON.stringify(tamper)).toBe(
        false,
      );

    const scope = { orgId: kit.org.id, mode: 'live' as const };
    await deletePass(db(), kit.env, { id: u.pass.id, orgId: u.pass.orgId, mode: 'live' });
    expect(await retained(db(), kit.env, scope, u.scanId)).toBe(true);
    expect(await retained(db(), kit.env, scope, u.targetId)).toBe(true);
    // `undoes` is a signed fact: the retained undo cannot be repointed.
    await run(db(), 'UPDATE scans SET undoes = ? WHERE id = ?', [u.scanId, u.scanId]);
    expect(await retained(db(), kit.env, scope, u.scanId)).toBe(false);
  });

  it('commits nothing when the proof insert fails: the target stays checked in', async () => {
    const s = await desk([tpl]);
    const pass = await kit.scanPass(tpl, {});
    const target = await out(await act(s.headers, codeOf(pass), { actionId: 'check_in' }));
    await run(
      db(),
      "CREATE TRIGGER undo_proof_refused BEFORE INSERT ON scan_retention_proofs BEGIN SELECT RAISE(ABORT, 'proof refused'); END",
    );
    try {
      expect((await undoScan(s.headers, target.scanId)).status).toBeGreaterThanOrEqual(400);
    } finally {
      await run(db(), 'DROP TRIGGER undo_proof_refused');
    }
    expect(await first(db(), 'SELECT undone_by FROM scans WHERE id = ?', [target.scanId])).toEqual({
      undone_by: null,
    });
    expect(await all(db(), 'SELECT 1 FROM scans WHERE undoes = ?', [target.scanId])).toEqual([]);
    expect(
      await all(db(), "SELECT 1 FROM pass_events WHERE pass_id = ? AND kind = 'scan.undone'", [
        pass.id,
      ]),
    ).toEqual([]);
    expect((await undoScan(s.headers, target.scanId)).status).toBe(200);
  });

  it('aborts the batch when the written row drifts from the facts the proof signs', async () => {
    const s = await desk([tpl]);
    const pass = await kit.scanPass(tpl, {});
    const target = await out(await act(s.headers, codeOf(pass), { actionId: 'check_in' }));
    await run(
      db(),
      "CREATE TRIGGER undo_drift AFTER INSERT ON scans WHEN NEW.undoes IS NOT NULL BEGIN UPDATE scans SET method = 'camera' WHERE id = NEW.id; END",
    );
    try {
      expect((await undoScan(s.headers, target.scanId)).status).toBeGreaterThanOrEqual(400);
    } finally {
      await run(db(), 'DROP TRIGGER undo_drift');
    }
    expect(await first(db(), 'SELECT undone_by FROM scans WHERE id = ?', [target.scanId])).toEqual({
      undone_by: null,
    });
    expect(await all(db(), 'SELECT 1 FROM scans WHERE undoes = ?', [target.scanId])).toEqual([]);
  });

  it('signs the undo of a value action, whose batch also publishes the pass', async () => {
    const t = await kit.scanTemplate('Undo proof add', {
      actions: [{ ...ADD, amount: 4 }],
    });
    const s = await desk([t]);
    const pass = await kit.scanPass(t, { balance: 10 });
    const scan = await out(await act(s.headers, codeOf(pass), { actionId: 'add' }));
    const res = await undoScan(s.headers, scan.scanId);
    expect(res.status, await res.clone().text()).toBe(200);
    const { scanId } = (await res.json()) as { scanId: string };
    expect(await proofCount(db(), scanId)).toBe(1);
    expect(await verifyStored(db(), kit.env, scanId)).toBe(true);
  });
});
