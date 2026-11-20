import { beforeAll, describe, expect, it } from 'vitest';
import { all, first, run } from '../../../platform/db.ts';
import { createJobContext } from '../../../platform/service-context.ts';
import { CHECK_IN } from '../act-test-fixtures.ts';
import { retainedEventCountSql } from '../repo-scan-retention.ts';
import { deletePass, verifyStored } from '../scan-retention-system-test-fixtures.ts';
import { scanningSessionsFixture } from '../scanning-sessions-test-fixtures.ts';
import { codeOf, key } from '../test-kit.ts';
import { exitGrant } from './auto-exit.ts';
import type { DueRow } from './repo-reads.ts';
import { exitAsGiven } from './rules.ts';
import { useKit } from './whos-in-test-fixtures.ts';

const fixture = scanningSessionsFixture();
let tpl: string;
beforeAll(async () => {
  await fixture.setup();
  useKit(fixture.kit);
  tpl = await fixture.kit.scanTemplate('Arrivals', { actions: [CHECK_IN] });
});
const kit = () => fixture.kit;
const db = () => kit().env.DB;

/** A pass checked in at a fresh exit-tracking event through the device API. */
async function arrived(o: { mode?: 'live' | 'test'; template?: string } = {}) {
  const template = o.template ?? tpl;
  const event = await kit().event({ templateIds: [template] });
  await run(db(), 'UPDATE scan_events SET reentry = 1 WHERE id = ?', [event.id]);
  const scanner = await kit().scanner({
    eventId: event.id,
    settings: { roleWithoutSignIn: 'desk' },
  });
  const pass = await kit().scanPass(template, {}, o.mode ? { mode: o.mode } : {});
  const res = await kit().post(scanner.headers, '/actions', {
    input: codeOf(pass),
    actionId: 'check_in',
    clientTs: kit().clock.now(),
    idempotencyKey: key(),
  });
  expect(res.status).toBe(200);
  return { event, pass, scanner, place: `event:${event.id}` };
}

const markOut = (eventId: string, passId: string, place: string) =>
  fixture.call('POST', `/scan-events/${eventId}/mark-out`, { passId, place });
const total = async (eventId: string, inside = false) =>
  (
    await first<{ n: number }>(
      db(),
      `SELECT ${retainedEventCountSql('?', "'live'", '?', inside)} AS n`,
      [kit().org.id, eventId],
    )
  )?.n;

describe('mark-out keeps the pass in the event totals', () => {
  it('retains an exited, then deleted, pass as arrived and not inside', async () => {
    const a = await arrived();
    const stay = await arrived();
    expect((await markOut(a.event.id, a.pass.id, a.place)).status).toBe(204);
    const scan = await first<{ id: string }>(
      db(),
      "SELECT id FROM scans WHERE pass_id = ? AND out_cause = 'desk'",
      [a.pass.id],
    );
    const proof = await first<{ gate_snapshot: string | null; presence_snapshot: string | null }>(
      db(),
      'SELECT gate_snapshot, presence_snapshot FROM scan_retention_proofs WHERE scan_id = ?',
      [scan?.id ?? ''],
    );
    expect(JSON.parse(proof?.gate_snapshot ?? 'null')).toMatchObject({ kind: 'check_in' });
    expect(JSON.parse(proof?.presence_snapshot ?? 'null')).toMatchObject({
      state: 'out',
      lastScanId: scan?.id,
    });
    expect(await verifyStored(db(), kit().env, scan?.id ?? '')).toBe(true);
    for (const p of [a, stay])
      await deletePass(db(), kit().env, {
        id: p.pass.id,
        orgId: kit().org.id,
        mode: 'live',
      });
    expect(await total(a.event.id)).toBe(1);
    expect(await total(a.event.id, true)).toBe(0);
    expect(await total(stay.event.id)).toBe(1);
    expect(await total(stay.event.id, true)).toBe(1);
  });

  it('retains nothing for another event or a tampered exit proof', async () => {
    const a = await arrived();
    expect((await markOut(a.event.id, a.pass.id, a.place)).status).toBe(204);
    const scan = await first<{ id: string }>(
      db(),
      "SELECT id FROM scans WHERE pass_id = ? AND out_cause = 'desk'",
      [a.pass.id],
    );
    await run(db(), 'UPDATE scans SET at = at + 1 WHERE id = ?', [scan?.id ?? '']);
    await deletePass(db(), kit().env, { id: a.pass.id, orgId: kit().org.id, mode: 'live' });
    expect(await total(a.event.id)).toBe(0);
    expect(
      await all(db(), 'SELECT 1 FROM scan_retained_gates WHERE event_id = ?', [a.event.id]),
    ).toEqual([]);
  });

  it('scopes the retained row to the pass tenant and mode', async () => {
    const a = await arrived();
    expect((await markOut(a.event.id, a.pass.id, a.place)).status).toBe(204);
    await deletePass(db(), kit().env, { id: a.pass.id, orgId: kit().org.id, mode: 'live' });
    expect(
      await first(
        db(),
        'SELECT org_id, mode, state, presence_state FROM scan_retained_gates WHERE event_id = ?',
        [a.event.id],
      ),
    ).toEqual({ org_id: kit().org.id, mode: 'live', state: 'out', presence_state: 'out' });
    const count = async (org: string, mode: string) =>
      (
        await first<{ n: number }>(
          db(),
          `SELECT ${retainedEventCountSql('?', '?', '?', false)} AS n`,
          [org, mode, a.event.id],
        )
      )?.n;
    expect(await count(kit().org.id, 'live')).toBe(1);
    expect(await count(kit().org.id, 'test')).toBe(0);
    expect(await count('other-org', 'live')).toBe(0);
  });

  it('leaves the earlier check-in proof as signed, with no backfill', async () => {
    const a = await arrived();
    const checkIn = await first<{ id: string }>(db(), 'SELECT id FROM scans WHERE pass_id = ?', [
      a.pass.id,
    ]);
    const before = await first(db(), 'SELECT * FROM scan_retention_proofs WHERE scan_id = ?', [
      checkIn?.id ?? '',
    ]);
    expect((await markOut(a.event.id, a.pass.id, a.place)).status).toBe(204);
    expect(
      await first(db(), 'SELECT * FROM scan_retention_proofs WHERE scan_id = ?', [
        checkIn?.id ?? '',
      ]),
    ).toEqual(before);
  });

  it('keeps an auto-exited pass in the event totals, with snapshots on the new row', async () => {
    const a = await arrived();
    const row = await first<DueRow>(
      db(),
      `SELECT x.pass_id, x.org_id, x.mode, x.scope, x.entered_at, x.last_entry_at, x.last_scan_id, x.due_at,
         p.template_id FROM scan_presence x JOIN passes p ON p.id = x.pass_id WHERE x.pass_id = ?`,
      [a.pass.id],
    );
    if (!row) throw new Error('no presence');
    const jobs = createJobContext(kit().env, 'test', { clock: kit().clock });
    await (
      await exitGrant(jobs, row, exitAsGiven([], a.place), 'stay', kit().clock.now())
    ).commit();
    const scan = await first<{ id: string; event_id: string }>(
      db(),
      "SELECT id, event_id FROM scans WHERE pass_id = ? AND actor_key = 'sys:occupancy'",
      [a.pass.id],
    );
    expect(scan?.event_id).toBe(a.event.id);
    expect(
      await first(
        db(),
        'SELECT gate_snapshot IS NOT NULL AS g, presence_snapshot IS NOT NULL AS p FROM scan_retention_proofs WHERE scan_id = ?',
        [scan?.id ?? ''],
      ),
    ).toEqual({ g: 1, p: 1 });
    expect(await verifyStored(db(), kit().env, scan?.id ?? '')).toBe(true);
    await deletePass(db(), kit().env, { id: a.pass.id, orgId: kit().org.id, mode: 'live' });
    expect(await total(a.event.id)).toBe(1);
    expect(await total(a.event.id, true)).toBe(0);
  });

  const undo = (headers: Record<string, string>, scanId: string) =>
    kit().post(headers, `/scans/${scanId}/undo`, { idempotencyKey: key() });
  const checkIn = async (a: Awaited<ReturnType<typeof arrived>>) => {
    const res = await kit().post(a.scanner.headers, '/actions', {
      input: codeOf(a.pass),
      actionId: 'check_in',
      clientTs: kit().clock.now(),
      idempotencyKey: key(),
    });
    return (await res.json()) as { kind: string; scanId: string };
  };

  it('signs an undo of an event check-in with the gate and presence it leaves; the undone arrival is not retained', async () => {
    const a = await arrived();
    const target = await first<{ id: string }>(db(), 'SELECT id FROM scans WHERE pass_id = ?', [
      a.pass.id,
    ]);
    const res = await undo(a.scanner.headers, target?.id ?? '');
    expect(res.status, await res.clone().text()).toBe(200);
    const undoId = ((await res.json()) as { scanId: string }).scanId;
    const proof = await first<{ gate_snapshot: string | null; presence_snapshot: string | null }>(
      db(),
      'SELECT gate_snapshot, presence_snapshot FROM scan_retention_proofs WHERE scan_id = ?',
      [undoId],
    );
    expect(JSON.parse(proof?.gate_snapshot ?? 'null')).toMatchObject({
      state: 'undone',
      lastScanId: undoId,
    });
    expect(proof?.presence_snapshot).toBeNull();
    expect(await verifyStored(db(), kit().env, undoId)).toBe(true);
    await deletePass(db(), kit().env, { id: a.pass.id, orgId: kit().org.id, mode: 'live' });
    expect(await total(a.event.id)).toBe(0);
  });

  it('undoing a re-entry after a mark-out restores the exit and the pass stays counted', async () => {
    const repeat = await kit().scanTemplate('Repeat arrivals', {
      actions: [{ ...CHECK_IN, repeat: 'always' }],
    });
    const a = await arrived({ template: repeat });
    expect((await markOut(a.event.id, a.pass.id, a.place)).status).toBe(204);
    const again = await checkIn(a);
    expect(again.kind).toBe('ok');
    const res = await undo(a.scanner.headers, again.scanId);
    expect(res.status, await res.clone().text()).toBe(200);
    const presence = await first<{ state: string }>(
      db(),
      'SELECT state FROM scan_presence WHERE pass_id = ? AND scope = ?',
      [a.pass.id, a.place],
    );
    expect(presence?.state).toBe('out');
    await deletePass(db(), kit().env, { id: a.pass.id, orgId: kit().org.id, mode: 'live' });
    expect(await total(a.event.id)).toBe(1);
    expect(await total(a.event.id, true)).toBe(0);
  });
});
