import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CheckInPolicy } from '../../../shared/contracts/check-in.ts';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { all, first } from '../../platform/db.ts';
import { putPassCheckIn } from '../passes/check-in.ts';
import { beforeBatch } from './batch-interceptor-test-support.ts';
import { codeOf, key, type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
let template: string;
let baseline: number;
beforeAll(async () => {
  kit = await setupScanKit();
  baseline = kit.clock.now();
  template = await kit.scanTemplate('Admission races', {
    actions: [
      { id: 'check_in', label: 'Check in', kind: 'check_in' },
      { id: 'other', label: 'Other door', kind: 'check_in' },
    ],
  });
});
beforeEach(() => kit.clock.set(baseline));

type Pass = Awaited<ReturnType<ScanKit['scanPass']>>;
async function pass(rules: CheckInPolicy): Promise<Pass> {
  const p = await kit.scanPass(template);
  await putPassCheckIn(kit.ctx, { type: 'system', id: null }, p.id, rules, null);
  return p;
}
async function act(headers: Record<string, string>, p: Pass, actionId = 'check_in') {
  const response = await kit.post(headers, '/actions', {
    input: codeOf(p),
    clientTs: kit.clock.now(),
    idempotencyKey: key(),
    actionId,
  });
  expect(response.status).toBe(200);
  return (await response.json()) as ScanOutcome;
}

/** `rival` commits after `loser` read its admission, just before the loser's gate write runs. */
async function race(loser: () => Promise<ScanOutcome>, rival: () => Promise<ScanOutcome>) {
  let won: ScanOutcome | undefined;
  const { result, fired } = await beforeBatch(
    kit.env,
    /INSERT INTO scan_gates/i,
    async () => {
      won = await rival();
    },
    loser,
  );
  expect(fired).toBe(true);
  if (!won) throw new Error('The rival scan did not run.');
  return { lost: result, won };
}

const okScans = (p: Pass) =>
  all<{ id: string }>(kit.env.DB, "SELECT id FROM scans WHERE pass_id=? AND outcome='ok'", [p.id]);
const presence = (p: Pass) =>
  first<{ state: string; last_scan_id: string }>(
    kit.env.DB,
    'SELECT state, last_scan_id FROM scan_presence WHERE pass_id=?',
    [p.id],
  );
/** Gate holders by action: the loser never takes a gate it did not commit. */
const gates = async (p: Pass) =>
  Object.fromEntries(
    (
      await all<{ action_id: string; last_scan_id: string }>(
        kit.env.DB,
        'SELECT action_id, last_scan_id FROM scan_gates WHERE pass_id=?',
        [p.id],
      )
    ).map((g) => [g.action_id, g.last_scan_id]),
  );

describe('a check-in admits a pass once when another scan commits first', () => {
  it('an in/out pass scanned in at two doors: one entry, the loser is still inside', async () => {
    const p = await pass({ mode: 'in_out' });
    const a = await kit.scanner({ templateIds: [template], settings: { direction: 'in' } });
    const b = await kit.scanner({ templateIds: [template], settings: { direction: 'in' } });
    const { lost, won } = await race(
      () => act(a.headers, p),
      () => act(b.headers, p),
    );
    expect(won.kind).toBe('ok');
    expect(lost).toMatchObject({
      kind: 'heads_up',
      reason: 'still_inside',
      overridable: false,
      previous: { scanId: won.scanId },
    });
    expect((await okScans(p)).map((s) => s.id)).toEqual([won.scanId]);
    expect(await presence(p)).toEqual({ state: 'in', last_scan_id: won.scanId });
    expect(await gates(p)).toEqual({ check_in: won.scanId });
  });

  it('a single-use pass at two scanners with different check-in actions: one entry', async () => {
    const p = await pass({ mode: 'single' });
    const a = await kit.scanner({ templateIds: [template] });
    const b = await kit.scanner({ templateIds: [template] });
    const { lost, won } = await race(
      () => act(a.headers, p, 'check_in'),
      () => act(b.headers, p, 'other'),
    );
    expect(won.kind).toBe('ok');
    expect(lost).toMatchObject({
      kind: 'heads_up',
      reason: 'already_done',
      overridable: false,
      previous: { scanId: won.scanId },
    });
    expect((await okScans(p)).map((s) => s.id)).toEqual([won.scanId]);
    expect((await presence(p))?.last_scan_id).toBe(won.scanId);
    expect(await gates(p)).toEqual({ other: won.scanId });
  });

  it('a daily pass at two scanners on the same day: one entry', async () => {
    const p = await pass({ mode: 'daily' });
    const a = await kit.scanner({ templateIds: [template] });
    const b = await kit.scanner({ templateIds: [template] });
    const { lost, won } = await race(
      () => act(a.headers, p),
      () => act(b.headers, p),
    );
    expect(won.kind).toBe('ok');
    expect(lost).toMatchObject({ kind: 'heads_up', reason: 'already_done', overridable: false });
    expect((await okScans(p)).map((s) => s.id)).toEqual([won.scanId]);
    expect(await gates(p)).toEqual({ check_in: won.scanId });
  });

  it('a single-use pass whose entry was undone admits one of two racing re-entries', async () => {
    const p = await pass({ mode: 'single' });
    const a = await kit.scanner({ templateIds: [template] });
    const b = await kit.scanner({ templateIds: [template] });
    const first = await act(a.headers, p);
    expect(first.kind).toBe('ok');
    const undone = await kit.post(a.headers, `/scans/${first.scanId}/undo`, {
      idempotencyKey: key(),
    });
    expect(undone.status).toBe(200);
    expect(await presence(p)).toBeNull();
    const { lost, won } = await race(
      () => act(a.headers, p),
      () => act(b.headers, p),
    );
    expect(won.kind).toBe('ok');
    expect(lost).toMatchObject({ kind: 'heads_up', reason: 'already_done', overridable: false });
    const live = await all<{ id: string }>(
      kit.env.DB,
      "SELECT id FROM scans WHERE pass_id=? AND outcome='ok' AND undone_by IS NULL AND undoes IS NULL",
      [p.id],
    );
    expect(live.map((s) => s.id)).toEqual([won.scanId]);
    expect(await gates(p)).toEqual({ check_in: won.scanId });
  });

  it('control: a rival scan of another pass leaves the entry admitted', async () => {
    const p = await pass({ mode: 'in_out' });
    const other = await pass({ mode: 'in_out' });
    const a = await kit.scanner({ templateIds: [template], settings: { direction: 'in' } });
    const b = await kit.scanner({ templateIds: [template], settings: { direction: 'in' } });
    const { lost, won } = await race(
      () => act(a.headers, p),
      () => act(b.headers, other),
    );
    expect(won.kind).toBe('ok');
    expect(lost.kind).toBe('ok');
    expect(lost.checkIn).toMatchObject({ direction: 'in', inside: true });
    expect(await presence(p)).toEqual({ state: 'in', last_scan_id: lost.scanId });
  });

  it('control: a daily pass is admitted when the rival scan matches nothing', async () => {
    const p = await pass({ mode: 'daily' });
    const a = await kit.scanner({ templateIds: [template] });
    const { lost, won } = await race(
      () => act(a.headers, p),
      () => act(a.headers, { ...p, scanCode: 'NOPE' }),
    );
    expect(won).toMatchObject({ kind: 'refused', reason: 'not_found' });
    expect(lost.kind).toBe('ok');
    expect((await okScans(p)).map((s) => s.id)).toEqual([lost.scanId]);
  });
});
