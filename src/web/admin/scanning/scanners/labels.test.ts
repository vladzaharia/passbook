import { describe, expect, it } from 'vitest';
import { scannerFixture as s } from '../test-fixtures.ts';
import { acceptsText, formatCode, formatCountdown, scannerStatus } from './labels.ts';

describe('scanner labels', () => {
  it('reads status from the wire: revoked, not paired, then heartbeat', () => {
    expect(scannerStatus(s({ status: 'revoked' }))).toBe('revoked');
    expect(scannerStatus(s({ status: 'not_paired', online: false }))).toBe('not_paired');
    expect(scannerStatus(s({ online: true }))).toBe('online');
    expect(scannerStatus(s({ online: false }))).toBe('offline');
  });

  it('names what a scanner accepts', () => {
    expect(acceptsText(s({ accepts: { templateIds: ['a', 'b'] } }))).toBe('2 templates');
    expect(acceptsText(s({ accepts: { templateIds: ['a'] } }))).toBe('1 template');
    expect(acceptsText(s({ accepts: { eventId: 'e1' } }), 'Saturday gala')).toBe('Saturday gala');
    expect(acceptsText(s({ accepts: { eventId: 'e1' } }))).toBe('An event');
  });

  it('shows the pairing code in two groups and the countdown as m:ss', () => {
    expect(formatCode('k7qh2m9xtr')).toBe('K7QH2-M9XTR');
    expect(formatCode('K7QH2-M9XTR')).toBe('K7QH2-M9XTR');
    expect(formatCountdown(582_000)).toBe('9:42');
    expect(formatCountdown(5_000)).toBe('0:05');
    expect(formatCountdown(-40)).toBe('0:00');
  });
});
