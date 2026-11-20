import { describe, expect, it } from 'vitest';
import type { HistoryItem } from '../../../../shared/contracts/scan-history.ts';
import { groupDays, lineOf } from './history-model.ts';

const NOW = Date.UTC(2026, 10, 19, 18, 0);
const item = (over: Partial<HistoryItem>): HistoryItem => ({
  id: 'a',
  at: NOW - 60_000,
  event: 'checked_in',
  reason: null,
  label: null,
  place: 'Front desk',
  staff: null,
  amount: null,
  ...over,
});

describe('a history line', () => {
  it('reads where and who for a check-in, check-out and note', () => {
    expect(lineOf(item({ staff: 'Theo B.' }), 'UTC')).toMatchObject({
      title: 'Checked in',
      sub: 'Front desk · Theo B.',
      tone: 'ok',
    });
    expect(lineOf(item({ event: 'checked_out', place: 'Turnstile A' }), 'UTC')).toMatchObject({
      title: 'Checked out',
      sub: 'Turnstile A',
    });
    expect(lineOf(item({ event: 'note', place: null, staff: 'Jonas W.' }), 'UTC')).toMatchObject({
      title: 'Note added',
      sub: 'Jonas W.',
      glyph: 'note',
    });
  });

  it('names a refusal or a hold by its reason, from the one copy table', () => {
    const refused = lineOf(item({ event: 'refused', reason: 'guest_visits_used' }), 'UTC');
    expect(refused.tone).toBe('no');
    expect(refused.title).not.toBe('Refused');
    expect(lineOf(item({ event: 'refused' }), 'UTC').title).toBe('Refused');
    expect(lineOf(item({ event: 'held', reason: 'already_done' }), 'UTC').tone).toBe('hu');
  });

  it('says who let them in and why', () => {
    const line = lineOf(
      item({ event: 'let_in', staff: 'Ana R.', reason: 'already_done', place: 'Turnstile A' }),
      'UTC',
    );
    expect(line.title).toBe('Let in by Ana R.');
    expect(line.sub).toContain('Turnstile A');
  });

  it('strikes an undone scan and signs a value change', () => {
    expect(lineOf(item({ event: 'undone' }), 'UTC').struck).toBe(true);
    expect(
      lineOf(item({ event: 'value', label: 'Add stamp', amount: 2, place: null }), 'UTC'),
    ).toMatchObject({ title: 'Add stamp', sub: '+2' });
    expect(lineOf(item({ event: 'value', label: 'Use', amount: -1, place: null }), 'UTC').sub).toBe(
      '-1',
    );
  });

  it('shows a scan with no proof as a time and a place only', () => {
    expect(lineOf(item({ event: 'scanned' }), 'UTC')).toMatchObject({
      title: 'Scanned',
      sub: 'Front desk',
      tone: 'muted',
    });
  });
});

describe('history by day', () => {
  it('splits where the day changes in the zone, newest first, and names today and yesterday', () => {
    const days = groupDays(
      [
        item({ id: '1', at: NOW - 60_000 }),
        item({ id: '2', at: NOW - 120_000 }),
        item({ id: '3', at: NOW - 24 * 3_600_000 }),
        item({ id: '4', at: NOW - 5 * 24 * 3_600_000 }),
      ],
      'UTC',
      NOW,
    );
    expect(days.map((d) => d.heading)).toEqual(['Today', 'Yesterday', 'Sat, Nov 14']);
    expect(days.map((d) => d.lines.length)).toEqual([2, 1, 1]);
  });

  it('cuts the day in the session zone, not the browser one', () => {
    // 02:00 UTC on Nov 19 is still Nov 18 in New York.
    const at = Date.UTC(2026, 10, 19, 2, 0);
    const days = groupDays([item({ at })], 'America/New_York', Date.UTC(2026, 10, 19, 12, 0));
    expect(days[0]?.heading).toBe('Yesterday');
  });
});
