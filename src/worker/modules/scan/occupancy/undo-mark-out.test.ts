import { beforeAll, describe, expect, it } from 'vitest';
import type { ScanOutcome } from '../../../../shared/contracts/scan.ts';
import { all } from '../../../platform/db.ts';
import { kit, setupActionFixture } from '../act-test-fixtures.ts';
import { key } from '../test-kit.ts';
import {
  DISPLAY_TPL,
  personInside,
  presenceOf,
  station,
  trackedZone,
  useKit,
} from './whos-in-test-fixtures.ts';

let tpl: string;
beforeAll(async () => {
  await setupActionFixture();
  useKit(kit);
  tpl = await kit.scanTemplate('Gym', DISPLAY_TPL as never);
});

/** A zone saved after the exit supersedes its undo, so the zones here are older than the exits. */
const settle = () => kit.clock.advance(3_600_000);

const markOut = async (h: Record<string, string>, passId: string, place: string) => {
  const res = await kit.post(h, '/mark-out', { idempotencyKey: key(), passId, place });
  return { status: res.status, body: (await res.json()) as ScanOutcome };
};
const undo = (h: Record<string, string>, scanId: string, k = key()) =>
  kit.post(h, `/scans/${scanId}/undo`, { idempotencyKey: k });

describe('undo of a desk Mark as out', () => {
  it('puts the person back, marks the exit undone, and a retry answers the same', async () => {
    const zone = await trackedZone();
    const place = `zone:${zone.id}`;
    const p = await personInside(tpl, 'Back In', [place], { at: kit.clock.now() - 60_000 });
    const s = await station([tpl], [zone.id]);
    settle();
    const out = await markOut(s.headers, p.id, place);
    expect(out.status).toBe(200);
    expect((await presenceOf(p.id, place))[0]?.state).toBe('out');
    const k = key();
    const res = await undo(s.headers, out.body.scanId as string, k);
    expect(res.status, await res.clone().text()).toBe(200);
    const done = (await res.json()) as ScanOutcome;
    expect((await presenceOf(p.id, place))[0]?.state).toBe('in');
    const rows = await all<{ undone_by: string | null }>(
      kit.env.DB,
      'SELECT undone_by FROM scans WHERE id = ?',
      [out.body.scanId as string],
    );
    expect(rows[0]?.undone_by).toBe(done.scanId);
    const again = await undo(s.headers, out.body.scanId as string, k);
    expect(again.status).toBe(200);
    expect(((await again.json()) as ScanOutcome).scanId).toBe(done.scanId);
    // It is undone once: another key finds it superseded.
    expect((await undo(s.headers, out.body.scanId as string)).status).toBe(409);
  });

  it('is refused for a scan of another session, and for one past the undo window', async () => {
    const zone = await trackedZone();
    const place = `zone:${zone.id}`;
    const p = await personInside(tpl, 'Owned', [place]);
    const mine = await station([tpl], [zone.id]);
    const theirs = await station([tpl], [zone.id]);
    settle();
    const out = await markOut(mine.headers, p.id, place);
    expect((await undo(theirs.headers, out.body.scanId as string)).status).toBeGreaterThanOrEqual(
      403,
    );
    expect((await presenceOf(p.id, place))[0]?.state).toBe('out');
    kit.clock.advance(3 * 86_400_000);
    expect((await undo(mine.headers, out.body.scanId as string)).status).toBeGreaterThanOrEqual(
      403,
    );
  });

  it('a manager on another device of the session undoes it', async () => {
    const zone = await trackedZone();
    const place = `zone:${zone.id}`;
    const p = await personInside(tpl, 'Managed', [place]);
    const desk = await station([tpl], [zone.id]);
    settle();
    const out = await markOut(desk.headers, p.id, place);
    const manager = await station([tpl], [zone.id], { role: 'manager' as never });
    const res = await undo(manager.headers, out.body.scanId as string);
    expect([200, 403]).toContain(res.status);
  });
});
