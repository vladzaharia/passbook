import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { run } from '../../platform/db.ts';
import { dayLimitEnd } from './admission.ts';
import { admitOf } from './admit.ts';
import type { ScanActor } from './guard.ts';
import type { Found } from './resolve.ts';
import { codeOf, key, type ScanKit, setupScanKit } from './test-kit.ts';

const NY = 'America/New_York';
// 10:00 EST. New York midnight is 05:00 UTC.
const MORNING = Date.UTC(2026, 10, 5, 15, 0, 0);
const MIDNIGHT = Date.UTC(2026, 10, 6, 5, 0, 0);

let kit: ScanKit;
let baseline: number;
beforeAll(async () => {
  kit = await setupScanKit();
  baseline = kit.clock.now();
});
beforeEach(() => kit.clock.set(MORNING));

async function door(template: string, zone = NY) {
  const scanner = await kit.scanner({ templateIds: [template] });
  await run(kit.env.DB, 'UPDATE scanners SET time_zone = ? WHERE id = ?', [zone, scanner.id]);
  return scanner;
}
async function scan(
  scanner: Awaited<ReturnType<typeof door>>,
  p: Awaited<ReturnType<typeof kit.scanPass>>,
) {
  const response = await kit.post(scanner.headers, '/actions', {
    input: codeOf(p),
    clientTs: kit.clock.now(),
    idempotencyKey: key(),
    actionId: 'check_in',
  });
  expect(response.status).toBe(200);
  return (await response.json()) as ScanOutcome;
}

describe('day pass', () => {
  it('ends at midnight in the session zone and stays re-enterable until then', async () => {
    const template = await kit.scanTemplate('Day pass', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
      checkIn: { mode: 'unlimited', days: 1 },
    });
    const p = await kit.scanPass(template);
    const scanner = await door(template);
    const first = await scan(scanner, p);
    expect(first.kind).toBe('ok');
    expect(first.admit).toEqual({
      type: 'Day pass',
      rule: { kind: 'until', at: MIDNIGHT },
      timeZone: NY,
    });
    kit.clock.set(MIDNIGHT - 1);
    expect((await scan(scanner, p)).kind).toBe('ok');
    kit.clock.set(MIDNIGHT);
    const late = await scan(scanner, p);
    expect(late.kind).not.toBe('ok');
    expect(late.reason).toBe('ended');
    expect(late.at).toBe(MIDNIGHT);
  });

  it('a pass rule replaces the type default', async () => {
    const template = await kit.scanTemplate('Two-day pass', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
      checkIn: { mode: 'unlimited', days: 2 },
    });
    const p = await kit.scanPass(template);
    const scanner = await door(template);
    const out = await scan(scanner, p);
    expect(out.admit?.rule).toEqual({ kind: 'until', at: MIDNIGHT + 86_400_000 });
  });
});

describe('repeat modes of a pass type', () => {
  it('daily admits once a day and says so', async () => {
    const template = await kit.scanTemplate('Monthly', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
      checkIn: { mode: 'daily' },
    });
    const p = await kit.scanPass(template);
    const scanner = await door(template);
    const first = await scan(scanner, p);
    expect(first.kind).toBe('ok');
    expect(first.admit).toMatchObject({ type: 'Monthly', rule: { kind: 'daily' } });
    expect((await scan(scanner, p)).reason).toBe('already_done');
  });

  it('single admits once', async () => {
    const template = await kit.scanTemplate('Ticket', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
      checkIn: { mode: 'single' },
    });
    const out = await scan(await door(template), await kit.scanPass(template));
    expect(out.admit?.rule).toEqual({ kind: 'once' });
  });

  it('a type without checkIn has no admit rule beyond its name', async () => {
    const template = await kit.scanTemplate('Plain', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in', repeat: 'always' }],
    });
    const out = await scan(await door(template), await kit.scanPass(template));
    expect(out.admit).toMatchObject({ type: 'Plain', rule: null });
  });
});

describe('admitOf', () => {
  const actor = { timeZone: 'UTC' } as ScanActor;
  const found = (over: Partial<Found> = {}) =>
    ({ ref: { name: 'Gym' }, scan: { actions: [] }, ...over }) as unknown as Found;
  const access = (over: object) =>
    ({
      plan: { id: 'g', label: 'Guest', kind: 'guest' },
      zone: null,
      closesAt: null,
      nextOpenAt: null,
      visits: null,
      visit: false,
      timeZone: 'UTC',
      ...over,
    }) as never;

  it('names the plan and counts a guest visit', () => {
    expect(admitOf(found(), actor, access({ visits: { used: 2, limit: 3 }, visit: true }))).toEqual(
      { type: 'Guest', rule: { kind: 'visit', n: 2, of: 3 }, timeZone: 'UTC' },
    );
  });
  it('says how many visits are left when the scan did not count one', () => {
    expect(admitOf(found(), actor, access({ visits: { used: 2, limit: 10 } })).rule).toEqual({
      kind: 'left',
      n: 8,
    });
  });
  it('an event wins over the plan', () => {
    const f = found({
      admission: { event: { name: 'Summer Gala', timeZone: 'UTC' }, state: {} } as never,
    });
    expect(admitOf(f, actor, null)).toMatchObject({
      type: 'Gym',
      rule: { kind: 'event', name: 'Summer Gala' },
    });
  });
  it('a plan end is an until', () => {
    expect(admitOf(found(), actor, access({ closesAt: 5 })).rule).toEqual({
      kind: 'until',
      at: 5,
    });
  });
});

describe('dayLimitEnd', () => {
  it('counts local days across a DST change', () => {
    // 2026-03-07 20:00 EST; the clocks go forward on 03-08.
    const at = Date.UTC(2026, 2, 8, 1, 0, 0);
    expect(dayLimitEnd(at, 1, NY)).toBe(Date.UTC(2026, 2, 8, 5, 0, 0));
    expect(dayLimitEnd(at, 2, NY)).toBe(Date.UTC(2026, 2, 9, 4, 0, 0));
  });
});

it('keeps the baseline clock for later files', () => {
  kit.clock.set(baseline);
});
