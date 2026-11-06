import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CheckInPolicy } from '../../../shared/contracts/check-in.ts';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { all, run } from '../../platform/db.ts';
import { putPassCheckIn } from '../passes/check-in.ts';
import { presenceOf } from './repo-admission.ts';
import { codeOf, key, type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
let template: string;
let baseline: number;
beforeAll(async () => {
  kit = await setupScanKit();
  baseline = kit.clock.now();
  template = await kit.scanTemplate('Admission rules', {
    actions: [
      { id: 'check_in', label: 'Check in', kind: 'check_in' },
      { id: 'other', label: 'Other door', kind: 'check_in' },
    ],
  });
});
beforeEach(() => kit.clock.set(baseline));
async function pass(rules: CheckInPolicy) {
  const p = await kit.scanPass(template);
  await putPassCheckIn(kit.ctx, { type: 'system', id: null }, p.id, rules, null);
  return p;
}
async function act(
  headers: Record<string, string>,
  p: Awaited<ReturnType<typeof pass>>,
  over = {},
) {
  const response = await kit.post(headers, '/actions', {
    input: codeOf(p),
    clientTs: kit.clock.now(),
    idempotencyKey: key(),
    actionId: 'check_in',
    ...over,
  });
  expect(response.status).toBe(200);
  return (await response.json()) as ScanOutcome;
}

describe('configured admission rules', () => {
  it('starts tracking with an entry after earlier untracked visits', async () => {
    const p = await pass({ mode: 'unlimited' });
    const scanner = await kit.scanner({ templateIds: [template], settings: { direction: 'both' } });
    expect((await act(scanner.headers, p)).kind).toBe('ok');
    await putPassCheckIn(kit.ctx, { type: 'system', id: null }, p.id, { mode: 'in_out' }, null);
    expect((await act(scanner.headers, p)).checkIn).toMatchObject({
      direction: 'in',
      inside: true,
    });
    expect((await act(scanner.headers, p)).checkIn).toMatchObject({
      direction: 'out',
      inside: false,
    });
  });

  it('honors an event’s no-re-entry setting while permitting its recorded exit', async () => {
    const event = await kit.event({ templateIds: [template] });
    const p = await pass({ mode: 'in_out', eventId: event.id });
    const scanner = await kit.scanner({ eventId: event.id, settings: { direction: 'both' } });
    expect((await act(scanner.headers, p)).checkIn?.direction).toBe('in');
    expect((await act(scanner.headers, p)).checkIn?.direction).toBe('out');
    expect(await act(scanner.headers, p)).toMatchObject({
      kind: 'heads_up',
      reason: 'already_done',
      overridable: false,
    });
  });
  it('uses a scanner type for passes without an explicit pass policy', async () => {
    const p = await kit.scanPass(template);
    const scanner = await kit.scanner({
      templateIds: [template],
      settings: { checkIn: { mode: 'in_out' }, direction: 'both' },
    });
    const directions = [];
    for (let i = 0; i < 3; i++) directions.push((await act(scanner.headers, p)).checkIn?.direction);
    expect(directions).toEqual(['in', 'out', 'in']);
  });

  it('combines daily entry limits with in/out tracking and always permits the recorded exit', async () => {
    const p = await pass({ mode: 'in_out' });
    const scanner = await kit.scanner({
      templateIds: [template],
      settings: { checkIn: { mode: 'daily' }, direction: 'both' },
    });
    expect((await act(scanner.headers, p)).checkIn?.direction).toBe('in');
    expect((await act(scanner.headers, p)).checkIn?.direction).toBe('out');
    expect((await act(scanner.headers, p)).reason).toBe('already_done');
    kit.clock.advance(86_400_000);
    expect((await act(scanner.headers, p)).checkIn?.direction).toBe('in');
  });
  it('uses the issue date as a duration anchor when configured', async () => {
    const p = await pass({ mode: 'unlimited', durationMinutes: 5, durationFrom: 'issued' });
    const scanner = await kit.scanner({ templateIds: [template] });
    kit.clock.advance(300_000);
    expect((await act(scanner.headers, p)).reason).toBe('ended');
  });

  it('keeps capacity atomic when a returning member races a new arrival', async () => {
    const event = await kit.event({ templateIds: [template] });
    await run(kit.env.DB, 'UPDATE scan_events SET capacity=1,reentry=1 WHERE id=?', [event.id]);
    const a = await pass({ mode: 'in_out', eventId: event.id });
    const b = await pass({ mode: 'in_out', eventId: event.id });
    const entry = await kit.scanner({ eventId: event.id, settings: { direction: 'in' } });
    const exit = await kit.scanner({ eventId: event.id, settings: { direction: 'out' } });
    expect((await act(entry.headers, a)).kind).toBe('ok');
    expect((await act(exit.headers, a)).kind).toBe('ok');
    const results = await Promise.all([act(entry.headers, a), act(entry.headers, b)]);
    expect(results.filter((r) => r.kind === 'ok')).toHaveLength(1);
    expect(results.find((r) => r.kind !== 'ok')?.reason).toBe('capacity_full');
    expect(Math.max(...results.map((r) => r.counts.event?.inside ?? 0))).toBe(1);
  });
  it('allows one entry across scanners and action IDs, with no check-out or override', async () => {
    const p = await pass({ mode: 'single' });
    const a = await kit.scanner({ templateIds: [template] });
    const b = await kit.scanner({ templateIds: [template] });
    expect((await act(a.headers, p)).kind).toBe('ok');
    expect(await act(b.headers, p, { actionId: 'other' })).toMatchObject({
      kind: 'heads_up',
      reason: 'already_done',
      overridable: false,
    });
    const exit = await kit.scanner({ templateIds: [template], settings: { direction: 'out' } });
    expect(await act(exit.headers, p)).toMatchObject({ kind: 'refused', reason: 'not_accepted' });
  });

  it('continues enforcing a single use after scan history is pruned', async () => {
    const p = await pass({ mode: 'single' });
    const scanner = await kit.scanner({ templateIds: [template] });
    await act(scanner.headers, p);
    await run(kit.env.DB, 'DELETE FROM scans WHERE pass_id=?', [p.id]);
    expect((await act(scanner.headers, p)).reason).toBe('already_done');
  });

  it('allows unlimited entries and lets a scanner add a daily restriction', async () => {
    const p = await pass({ mode: 'unlimited' });
    const scanner = await kit.scanner({ templateIds: [template] });
    for (let i = 0; i < 3; i++) expect((await act(scanner.headers, p)).kind).toBe('ok');
    const limited = await kit.scanner({
      templateIds: [template],
      settings: { checkIn: { mode: 'daily' } },
    });
    expect((await act(limited.headers, p)).reason).toBe('already_done');
    kit.clock.advance(86_400_000);
    expect((await act(limited.headers, p)).kind).toBe('ok');
  });

  it('never lets scanner unlimited settings weaken a single-use pass', async () => {
    const p = await pass({ mode: 'single' });
    const scanner = await kit.scanner({
      templateIds: [template],
      settings: { checkIn: { mode: 'unlimited' } },
    });
    expect((await act(scanner.headers, p)).kind).toBe('ok');
    expect((await act(scanner.headers, p)).reason).toBe('already_done');
  });

  it('tracks entry, exit and re-entry across devices and undoes the latest transition', async () => {
    const p = await pass({ mode: 'in_out' });
    const entry = await kit.scanner({ templateIds: [template], settings: { direction: 'in' } });
    const exit = await kit.scanner({ templateIds: [template], settings: { direction: 'out' } });
    expect((await act(exit.headers, p)).reason).toBe('not_inside');
    const entered = await act(entry.headers, p);
    expect(entered.checkIn).toMatchObject({ direction: 'in', inside: true });
    expect((await act(entry.headers, p)).reason).toBe('still_inside');
    const left = await act(exit.headers, p);
    expect(left.checkIn).toMatchObject({ direction: 'out', inside: false });
    expect(
      (await kit.post(exit.headers, `/scans/${left.scanId}/undo`, { idempotencyKey: key() }))
        .status,
    ).toBe(200);
    expect((await presenceOf(kit.env.DB, p.orgId, p.id, ''))?.state).toBe('in');
    expect((await act(exit.headers, p)).kind).toBe('ok');
    expect((await act(entry.headers, p)).kind).toBe('ok');
  });

  it('automatically alternates in and out when the setup accepts both', async () => {
    const p = await pass({ mode: 'in_out' });
    const scanner = await kit.scanner({ templateIds: [template], settings: { direction: 'both' } });
    const directions = [];
    for (let i = 0; i < 3; i++) directions.push((await act(scanner.headers, p)).checkIn?.direction);
    expect(directions).toEqual(['in', 'out', 'in']);
  });

  it('atomically admits only one concurrent entry from two devices', async () => {
    const p = await pass({ mode: 'in_out' });
    const a = await kit.scanner({ templateIds: [template], settings: { direction: 'in' } });
    const b = await kit.scanner({ templateIds: [template], settings: { direction: 'in' } });
    const results = await Promise.all([act(a.headers, p), act(b.headers, p)]);
    expect(results.filter((r) => r.kind === 'ok')).toHaveLength(1);
    expect(
      await all(kit.env.DB, "SELECT id FROM scans WHERE pass_id=? AND outcome='ok'", [p.id]),
    ).toHaveLength(1);
  });

  it('enforces absolute dates and a duration from the first successful scan', async () => {
    const start = kit.clock.now() + 60_000;
    const p = await pass({
      mode: 'unlimited',
      validFrom: start,
      validUntil: start + 3_600_000,
      durationMinutes: 10,
      durationFrom: 'first_scan',
    });
    const scanner = await kit.scanner({ templateIds: [template] });
    expect((await act(scanner.headers, p)).reason).toBe('not_yet_valid');
    kit.clock.advance(60_000);
    expect((await act(scanner.headers, p)).checkIn?.validUntil).toBe(start + 600_000);
    kit.clock.advance(600_000);
    expect(await act(scanner.headers, p)).toMatchObject({ reason: 'ended', overridable: false });
  });

  it('lets a member leave after the admission window ends', async () => {
    const p = await pass({ mode: 'in_out', durationMinutes: 1 });
    const scanner = await kit.scanner({ templateIds: [template], settings: { direction: 'both' } });
    await act(scanner.headers, p);
    kit.clock.advance(60_001);
    expect((await act(scanner.headers, p)).checkIn?.direction).toBe('out');
    expect((await act(scanner.headers, p)).reason).toBe('ended');
  });

  it('binds a pass to an event and rejects another event', async () => {
    const event = await kit.event({ templateIds: [template] });
    const other = await kit.event({ templateIds: [template] });
    const p = await pass({ mode: 'single', eventId: event.id });
    const wrong = await kit.scanner({ eventId: other.id });
    expect((await act(wrong.headers, p)).reason).toBe('wrong_event');
    const scanner = await kit.scanner({ templateIds: [template] });
    expect((await act(scanner.headers, p)).kind).toBe('ok');
    expect(
      await all(kit.env.DB, "SELECT event_id FROM scans WHERE pass_id=? AND outcome='ok'", [p.id]),
    ).toEqual([{ event_id: event.id }]);
  });
});
