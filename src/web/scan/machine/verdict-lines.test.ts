import { describe, expect, it } from 'vitest';
import { ScanReasonSchema } from '../../../shared/contracts/scan.ts';
import { accessInfo, occupancyInfo } from './access-fixtures.test-support.ts';
import { FIXTURE_NOW, fixtureOutcome } from './fixture-data.test-support.ts';
import type { ScanOutcome } from './types.ts';
import { lineValues, verdictLine } from './verdict-lines.ts';

const CLIENT = [
  'network',
  'timeout',
  'unconfirmed',
  'still_unconfirmed',
  'server',
  'rate_limited',
  'saved_offline',
  'add_link',
] as const;
const REASONS = [...ScanReasonSchema.options, ...CLIENT] as ScanOutcome['reason'][];
const NOW = FIXTURE_NOW + 3 * 60_000;
const EVENT = { name: 'Summer Gala', startsAt: Date.UTC(2026, 10, 14, 18, 0) };
const VALUE = {
  input: 'balance',
  label: 'Balance',
  before: 4,
  after: 4,
  goal: null,
  format: 'currency' as const,
  currency: 'USD',
  need: 9,
};
const PREVIOUS = {
  scanId: '01900000-0000-7000-8000-0000000000c1',
  at: FIXTURE_NOW - 120_000,
  scannerName: 'Door 2',
  staffName: null,
  actionLabel: 'Add stamp',
  override: false,
};

/** One scan of each shape the server can send: bare, full, and sparse. */
const FIXTURES: Record<string, Partial<ScanOutcome>> = {
  bare: {},
  rich: {
    value: VALUE,
    previous: PREVIOUS,
    event: EVENT,
    access: accessInfo({
      nextOpenAt: FIXTURE_NOW + 3_600_000,
      closesAt: FIXTURE_NOW + 1_800_000,
      visits: { used: 3, limit: 3 },
    }),
    occupancy: occupancyInfo(),
    cooldownRemainingMs: 180_000,
    flags: ['Photo check'],
    retryAfterMs: 20_000,
  },
  sparse: {
    template: null,
    at: null,
    action: null,
    value: null,
    previous: null,
    event: null,
    access: null,
    occupancy: null,
    cooldownRemainingMs: null,
    flags: [],
  },
  stamp: { action: { id: 'add_stamp', label: 'Add stamp', kind: 'add' }, previous: PREVIOUS },
  checkIn: {
    action: { id: 'check_in', label: 'Check in', kind: 'check_in' },
    previous: PREVIOUS,
    event: EVENT,
  },
};

describe('every verdict line is filled from the outcome', () => {
  for (const [name, over] of Object.entries(FIXTURES))
    it.each(REASONS)(`leaves no { for %s on the ${name} fixture`, (reason) => {
      const kind =
        reason && /^(network|timeout|server|rate_limited)/.test(reason) ? 'system' : 'heads_up';
      const line = verdictLine(fixtureOutcome(kind, reason, over), NOW);
      expect(line, String(reason)).not.toBeNull();
      expect(line?.headline).not.toMatch(/[{}]/);
      expect(line?.sub).not.toMatch(/[{}]/);
      expect(line?.headline.trim().length).toBeGreaterThan(0);
      expect(line?.sub.trim().length).toBeGreaterThan(0);
    });

  it('has no line for an ok outcome', () => {
    expect(verdictLine(fixtureOutcome('ok'), NOW)).toBeNull();
  });
});

describe('what the lines say', () => {
  const line = (reason: ScanOutcome['reason'], over: Partial<ScanOutcome> = {}) =>
    verdictLine(fixtureOutcome('heads_up', reason, over), NOW);

  it('names the event and its weekday, never "this event"', () => {
    const wrong = line('wrong_event', { event: EVENT });
    expect(wrong?.sub).toBe('This scanner is for Summer Gala, Sat.');
    expect(line('wrong_event', { event: null })?.sub).toBe(
      'This scanner is for a different event.',
    );
    expect(line('capacity_full', { event: EVENT, occupancy: null })?.headline).toBe(
      'Summer Gala full',
    );
    expect(line('ended', { event: EVENT })?.headline).toBe('Summer Gala ended');
  });

  it('fills no_balance from the value, with currency', () => {
    const l = line('no_balance', { value: VALUE });
    expect(l?.headline).toBe('Not enough balance');
    expect(l?.sub).toBe('$4.00 left. Needs $9.00.');
  });

  it('fills a count value without currency', () => {
    const l = line('no_balance', { value: { ...VALUE, format: 'number', before: 2, need: 5 } });
    expect(l?.sub).toBe('2 left. Needs 5.');
  });

  it('names the action and the wait on a cooldown, not a check-in', () => {
    const l = line('cooldown', {
      action: { id: 'add_stamp', label: 'Add stamp', kind: 'add' },
      cooldownRemainingMs: 3 * 60_000,
    });
    expect(l?.headline).toBe('Just done');
    expect(l?.sub).toMatch(/^Add stamp at .+\. Next in 3 min\.$/);
  });

  it('says who and when on already_done, and tells staff to check ID', () => {
    const l = line('already_done', { previous: PREVIOUS });
    expect(l?.sub).toBe('5 min ago at Door 2. Check ID.');
    expect(l?.headline).toBe('Already done');
    expect(
      line('already_done', {
        previous: PREVIOUS,
        action: { id: 'c', label: 'Check in', kind: 'check_in' },
      })?.headline,
    ).toBe('Already checked in');
  });

  it('says the input and its value on a changed card', () => {
    const l = line('stale', {
      value: { ...VALUE, label: 'Tier', format: 'text', before: 'Gold', after: 'Gold' },
    });
    expect(l).toEqual({ headline: 'Tier changed', sub: 'Now Gold. Check it and set again.' });
  });

  it('counts visits used', () => {
    const l = line('guest_visits_used', {
      access: accessInfo({ visits: { used: 2, limit: 3 } }),
    });
    expect(l?.sub).toBe('Used 2 of 3 visits.');
  });

  it('tells staff what to do next on every refusal', () => {
    const next = /(Ask|Use|Look it up|Hold|Try|Scan|Check|Redeem|Keep|Change|Tap|Pick)/;
    for (const reason of [
      'not_found',
      'test_pass',
      'live_pass',
      'not_accepted',
      'removed',
      'voided',
      'expired',
      'managed_elsewhere',
      'limit_reached',
      'zone_not_included',
      'guest_expired',
      'suspended',
      'card_full',
      'network',
    ] as const)
      expect(verdictLine(fixtureOutcome('refused', reason), NOW)?.sub, reason).toMatch(next);
  });

  it('never hard-codes check-in words for a stamp action', () => {
    const stamp = FIXTURES.stamp as Partial<ScanOutcome>;
    for (const reason of REASONS) {
      const l = verdictLine(fixtureOutcome('heads_up', reason, stamp), NOW);
      expect(`${l?.headline} ${l?.sub}`, String(reason)).not.toMatch(
        /this event|checked in|check-in|check them in/i,
      );
    }
  });

  it('keeps values the access and occupancy lines already fill', () => {
    const v = lineValues(
      fixtureOutcome('heads_up', 'capacity_full', { occupancy: occupancyInfo() }),
      NOW,
    );
    expect(v).toMatchObject({ zone: 'Gym', in: 42, capacity: 60 });
  });
});
