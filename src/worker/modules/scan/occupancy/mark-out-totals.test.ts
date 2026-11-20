import { beforeAll, describe, expect, it } from 'vitest';
import { all, first, run } from '../../../platform/db.ts';
import { CHECK_IN } from '../act-test-fixtures.ts';
import { retainedEventCountSql } from '../repo-scan-retention.ts';
import { deletePass, verifyStored } from '../scan-retention-system-test-fixtures.ts';
import { scanningSessionsFixture } from '../scanning-sessions-test-fixtures.ts';
import { codeOf, key } from '../test-kit.ts';
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
async function arrived(o: { mode?: 'live' | 'test' } = {}) {
  const event = await kit().event({ templateIds: [tpl] });
  await run(db(), 'UPDATE scan_events SET reentry = 1 WHERE id = ?', [event.id]);
  const scanner = await kit().scanner({ eventId: event.id });
  const pass = await kit().scanPass(tpl, {}, o.mode ? { mode: o.mode } : {});
  const res = await kit().post(scanner.headers, '/actions', {
    input: codeOf(pass),
    actionId: 'check_in',
    clientTs: kit().clock.now(),
    idempotencyKey: key(),
  });
  expect(res.status).toBe(200);
  return { event, pass, place: `event:${event.id}` };
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
});
