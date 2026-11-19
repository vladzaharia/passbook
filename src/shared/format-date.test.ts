import { describe, expect, it } from 'vitest';
import { formatDayIn, formatEndedOn } from './format-date.ts';

const at = Date.UTC(2026, 10, 19, 1, 50);

describe('formatEndedOn locale', () => {
  it('formats in the visitor language and zone', () => {
    expect(
      formatEndedOn('voided', { modifiedAt: at, voidedAt: at }, 'America/New_York', 'en-US'),
    ).toBe('Nov 18, 2026');
    expect(formatEndedOn('voided', { modifiedAt: at, voidedAt: at }, 'Europe/Berlin', 'de')).toBe(
      '19. Nov. 2026',
    );
    expect(formatDayIn(at, 'UTC', 'fr')).toBe('19 nov. 2026');
  });

  it('defaults to en-US and UTC', () => {
    expect(formatEndedOn('voided', { modifiedAt: at })).toBe('Nov 19, 2026');
  });
});
