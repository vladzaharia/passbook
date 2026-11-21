import { describe, expect, it } from 'vitest';
import { passFixture } from './fixtures.ts';
import { type MyPass, toView } from './pass-view.ts';
import { frontOf, groupPasses, nextRelevant } from './stack-order.ts';

const NOW = Date.parse('2026-11-21T12:00:00Z');
const item = (over: Partial<MyPass> = {}, json: Record<string, unknown> = {}) => {
  const base = passFixture(over);
  const pass = { ...base, passJson: { ...base.passJson, ...json } };
  return { pass, view: toView(pass) };
};

describe('groupPasses', () => {
  it('puts expired, voided and removed passes in ended, test passes in test', () => {
    const groups = groupPasses([
      item({ id: 'live' }),
      item({ id: 'test', mode: 'test' }),
      item({ id: 'void', status: 'voided' }),
      item({ id: 'gone', removedAt: 1 }),
      item({ id: 'old' }, { expirationDate: '2020-01-01T00:00:00Z' }),
      item({ id: 'old-test', mode: 'test', status: 'voided' }),
    ]);
    expect(groups.live.map((i) => i.pass.id)).toEqual(['live']);
    expect(groups.test.map((i) => i.pass.id)).toEqual(['test']);
    expect(groups.ended.map((i) => i.pass.id)).toEqual(['void', 'gone', 'old', 'old-test']);
  });
});

describe('frontOf', () => {
  it('takes the soonest relevant live pass, else the newest', () => {
    const newest = item({ id: 'newest' });
    const later = item({ id: 'later' }, { relevantDate: '2026-11-25T18:00:00Z' });
    const soon = item(
      { id: 'soon' },
      { relevantDates: [{ startDate: '2026-11-22T18:00:00Z', endDate: '2026-11-22T23:00:00Z' }] },
    );
    const past = item({ id: 'past' }, { relevantDate: '2026-11-01T18:00:00Z' });
    expect(frontOf(groupPasses([newest, later, soon, past]), NOW)?.pass.id).toBe('soon');
    expect(frontOf(groupPasses([newest, past]), NOW)?.pass.id).toBe('newest');
  });

  it('keeps a pass whose date has started but not ended relevant', () => {
    const now = item({ id: 'now' }, { relevantDate: '2026-11-21T10:00:00Z' });
    expect(nextRelevant(now.pass, now.view, NOW)).toBe(Date.parse('2026-11-21T10:00:00Z'));
    const done = item({ id: 'done' }, { relevantDate: '2026-11-21T06:00:00Z' });
    expect(nextRelevant(done.pass, done.view, NOW)).toBeNull();
  });

  it('falls back to test, then ended passes, and to nothing', () => {
    const t = item({ id: 't', mode: 'test' });
    const v = item({ id: 'v', status: 'voided' });
    expect(frontOf(groupPasses([v, t]), NOW)?.pass.id).toBe('t');
    expect(frontOf(groupPasses([v]), NOW)?.pass.id).toBe('v');
    expect(frontOf(groupPasses([]), NOW)).toBeNull();
  });
});
