import { describe, expect, it } from 'vitest';
import { WEDGE_SLOW, WEDGE_STANDARD, WedgeDetector, type WedgeVerdict } from './wedge-detector.ts';

const CODE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Types `text` with `gap` ms between keys from `t0`. Returns the last verdict and the time of the last key. */
function type(d: WedgeDetector, text: string, gap: number, t0 = 0) {
  let t = t0;
  let last: WedgeVerdict = { v: 'none' };
  const verdicts: WedgeVerdict[] = [];
  for (const [i, ch] of [...text].entries()) {
    if (i > 0) t += gap;
    last = d.push({ k: 'char', ch, t });
    verdicts.push(last);
  }
  return { last, t, verdicts };
}

describe('WedgeDetector (AC 10.2 timelines)', () => {
  it('a 26-char code at 8 ms per key, then Enter, is a scan', () => {
    const d = new WedgeDetector(WEDGE_STANDARD);
    const { t, verdicts } = type(d, CODE, 8);
    expect(verdicts.at(-1)).toEqual({ v: 'burst' });
    const end = d.push({ k: 'end', key: 'Enter', t: t + 8 });
    expect(end).toEqual({ v: 'scan', code: CODE, start: 0, end: t, via: 'Enter' });
  });

  it('the same at 120 ms per key (a human) gives nothing; the first key is a human key after quiet', () => {
    const d = new WedgeDetector(WEDGE_STANDARD);
    const { t, verdicts } = type(d, CODE, 120);
    expect(verdicts.every((v) => v.v === 'none')).toBe(true);
    expect(d.push({ k: 'end', key: 'Enter', t: t + 120 })).toEqual({ v: 'none' });
    const lone = new WedgeDetector(WEDGE_STANDARD);
    lone.push({ k: 'char', ch: 'a', t: 0 });
    expect(lone.flushIdle(150)).toEqual({ v: 'human', ch: 'a' });
  });

  it('a 3-char burst is nothing', () => {
    const d = new WedgeDetector(WEDGE_STANDARD);
    const { t } = type(d, 'ABC', 8);
    expect(d.push({ k: 'end', key: 'Enter', t: t + 8 })).toEqual({ v: 'none' });
  });

  it('30 ms keys with a 200 ms gap in the middle are two bursts, neither accepted', () => {
    const d = new WedgeDetector(WEDGE_STANDARD);
    const first = type(d, 'ABC', 30);
    const second = type(d, 'DEF', 30, first.t + 200);
    expect(d.push({ k: 'end', key: 'Enter', t: second.t + 30 })).toEqual({ v: 'none' });
  });

  it('10 chars at 5 ms with no terminator, then 150 ms quiet, is a scan via idle', () => {
    const d = new WedgeDetector(WEDGE_STANDARD);
    const { t } = type(d, '0123456789', 5);
    expect(d.flushIdle(t + 149)).toEqual({ v: 'none' });
    expect(d.flushIdle(t + 150)).toEqual({
      v: 'scan',
      code: '0123456789',
      start: 0,
      end: t,
      via: 'idle',
    });
  });

  it('a short or slow unterminated burst is not accepted by idle', () => {
    const d = new WedgeDetector(WEDGE_STANDARD);
    const { t } = type(d, 'ABCDEF', 5); // 6 < idleMinLength 8
    expect(d.flushIdle(t + 150)).toEqual({ v: 'none' });
    const slow = new WedgeDetector(WEDGE_STANDARD);
    const s = type(slow, '0123456789', 40); // mean 40 > idleMaxMeanGapMs 30
    expect(slow.flushIdle(s.t + 150)).toEqual({ v: 'none' });
  });

  it('Shift between characters is ignored', () => {
    const d = new WedgeDetector(WEDGE_STANDARD);
    d.push({ k: 'char', ch: 'A', t: 0 });
    d.push({ k: 'ignore', t: 4 });
    d.push({ k: 'char', ch: 'B', t: 8 });
    d.push({ k: 'ignore', t: 12 });
    d.push({ k: 'char', ch: 'C', t: 16 });
    d.push({ k: 'char', ch: 'D', t: 24 });
    expect(d.push({ k: 'end', key: 'Enter', t: 32 })).toMatchObject({ v: 'scan', code: 'ABCD' });
  });

  it('other keys and repeats reset the buffer', () => {
    const d = new WedgeDetector(WEDGE_STANDARD);
    type(d, 'ABCDEF', 8);
    d.push({ k: 'other', t: 60 });
    expect(d.push({ k: 'end', key: 'Enter', t: 68 })).toEqual({ v: 'none' });
  });

  it('Tab ends a scan like Enter', () => {
    const d = new WedgeDetector(WEDGE_STANDARD);
    const { t } = type(d, CODE, 8);
    expect(d.push({ k: 'end', key: 'Tab', t: t + 8 })).toMatchObject({ v: 'scan', via: 'Tab' });
  });

  it('a terminator after a long pause is not a scan', () => {
    const d = new WedgeDetector(WEDGE_STANDARD);
    const { t } = type(d, CODE, 8);
    expect(d.push({ k: 'end', key: 'Enter', t: t + 500 })).toEqual({ v: 'none' });
  });

  it('more than maxLength characters resets', () => {
    const d = new WedgeDetector({ ...WEDGE_STANDARD, maxLength: 10 });
    const { verdicts } = type(d, 'ABCDEFGHIJK', 2);
    expect(verdicts.at(-1)).toEqual({ v: 'none' });
  });

  it('WEDGE_SLOW accepts 70 ms batches that WEDGE_STANDARD rejects', () => {
    const slow = new WedgeDetector(WEDGE_SLOW);
    const a = type(slow, CODE, 70);
    expect(slow.push({ k: 'end', key: 'Enter', t: a.t + 70 })).toMatchObject({ v: 'scan' });
    const std = new WedgeDetector(WEDGE_STANDARD);
    const b = type(std, CODE, 70);
    expect(std.push({ k: 'end', key: 'Enter', t: b.t + 70 })).toEqual({ v: 'none' });
  });

  it('knows whether the next key would start a new buffer', () => {
    const d = new WedgeDetector(WEDGE_STANDARD);
    expect(d.startsBuffer(0)).toBe(true);
    d.push({ k: 'char', ch: 'A', t: 0 });
    expect(d.startsBuffer(20)).toBe(false);
    expect(d.startsBuffer(200)).toBe(true);
  });
});
