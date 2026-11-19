import { describe, expect, it } from 'vitest';
import { STAGE, type StageTone, toneOfStatus } from './customer-tone.ts';

const TONES = Object.keys(STAGE) as StageTone[];

describe('customer stage tones', () => {
  it('gives every outcome its own colour, icon and words', () => {
    const outcomes: StageTone[] = ['accepted', 'checkedOut', 'rejected', 'failed'];
    for (const a of outcomes)
      for (const b of outcomes) {
        if (a === b) continue;
        expect(STAGE[a].icon, `${a} vs ${b} icon`).not.toBe(STAGE[b].icon);
        expect(STAGE[a].title, `${a} vs ${b} title`).not.toBe(STAGE[b].title);
        expect(STAGE[a].eyebrow, `${a} vs ${b} eyebrow`).not.toBe(STAGE[b].eyebrow);
      }
    expect(STAGE.rejected.signal).toBe('danger');
    expect(STAGE.failed.signal).toBe('warning');
    expect(STAGE.accepted.signal).toBe('success');
    expect(STAGE.checkedOut.signal).toBe('info');
  });
  it('every tone has copy', () => {
    for (const tone of TONES) {
      expect(STAGE[tone].title.length).toBeGreaterThan(0);
      expect(STAGE[tone].eyebrow.length).toBeGreaterThan(0);
    }
  });
  it('maps native status words and falls back to ready', () => {
    expect(toneOfStatus('failed')).toBe('failed');
    expect(toneOfStatus('checkedOut')).toBe('checkedOut');
    expect(toneOfStatus('nonsense')).toBe('ready');
  });
});
