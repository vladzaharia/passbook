import { describe, expect, it } from 'vitest';
import { admitLine } from './admit-line.ts';
import { FIXTURE_NOW, fixtureOutcome } from './fixture-data.test-support.ts';
import { verdictLine } from './verdict-lines.ts';

const ok = (admit: unknown) => fixtureOutcome('ok', null, { at: FIXTURE_NOW, admit } as never);

describe('admit line', () => {
  it('a day pass names its end in the zone', () => {
    const o = ok({
      type: 'Day pass',
      rule: { kind: 'until', at: FIXTURE_NOW + 3_600_000 },
      timeZone: 'UTC',
    });
    expect(admitLine(o)).toBe('Day pass · until 6:59 PM');
  });
  it('a guest counts visits', () => {
    expect(
      admitLine(ok({ type: 'Guest', rule: { kind: 'visit', n: 2, of: 3 }, timeZone: 'UTC' })),
    ).toBe('Guest · visit 2 of 3');
  });
  it('an event is its name', () => {
    expect(
      admitLine(
        ok({ type: 'Ticket', rule: { kind: 'event', name: 'Summer Gala' }, timeZone: 'UTC' }),
      ),
    ).toBe('Summer Gala');
  });
  it('a far end is left out and a type without a rule is its name', () => {
    const far = { kind: 'until', at: FIXTURE_NOW + 30 * 86_400_000 };
    expect(admitLine(ok({ type: 'Monthly', rule: far, timeZone: 'UTC' }))).toBe('Monthly');
    expect(admitLine(ok({ type: 'Plain', rule: null, timeZone: 'UTC' }))).toBe('Plain');
  });
  it('an outcome without admit (an older server) has no line', () => {
    expect(admitLine(fixtureOutcome('ok'))).toBeNull();
  });
});

describe('refusal copy', () => {
  const admit = { type: 'Day pass', rule: null, timeZone: 'UTC' };
  it('names the pass type', () => {
    const ended = fixtureOutcome('refused', 'ended', { at: FIXTURE_NOW, admit } as never);
    expect(verdictLine({ ...ended, event: null }, FIXTURE_NOW)?.headline).toBe('Day pass ended');
    const guest = fixtureOutcome('refused', 'guest_expired', { at: FIXTURE_NOW, admit } as never);
    expect(verdictLine(guest, FIXTURE_NOW)?.headline).toBe('Day pass ended');
    const used = fixtureOutcome('refused', 'guest_visits_used', { admit } as never);
    expect(verdictLine(used, FIXTURE_NOW)?.headline).toBe('Day pass: no visits left');
  });
  it('without admit keeps the old words', () => {
    const guest = fixtureOutcome('refused', 'guest_expired', { at: FIXTURE_NOW });
    expect(verdictLine(guest, FIXTURE_NOW)?.headline).toBe('Guest pass ended');
  });
  it('words the end in the admit zone', () => {
    const at = Date.UTC(2026, 10, 5, 15, 0, 0);
    const o = fixtureOutcome('refused', 'ended', {
      at,
      admit: { type: 'Day pass', rule: null, timeZone: 'America/New_York' },
    } as never);
    expect(verdictLine({ ...o, event: null }, at)?.sub).toBe('Ended 10:00 AM.');
  });
});
