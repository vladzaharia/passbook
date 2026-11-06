import { describe, expect, it } from 'vitest';
import { SCAN_TIMING } from '../timing.ts';
import { decodeActive, pendingBadge, readerChip, readerNoRead } from './derive.ts';
import { FIXTURE_NOW, fixtureState, states } from './fixtures.test-support.ts';

describe('decodeActive', () => {
  it('runs in ready, verdict and member (B keeps the camera live) and stops only while checking', () => {
    expect(decodeActive(states.ready(), true)).toBe(true);
    expect(decodeActive(states.verdict('ok'), true)).toBe(true);
    expect(decodeActive(states.member(), true)).toBe(true);
    expect(decodeActive(states.checking(), true)).toBe(false);
    expect(decodeActive(states.paused(), true)).toBe(false);
  });

  it('needs the Start tap, a live camera, a visible page, no block and no overlay', () => {
    expect(decodeActive(states.start(), true)).toBe(false);
    expect(decodeActive(states.camera('blocked'), true)).toBe(false);
    expect(decodeActive(states.ready(), false)).toBe(false);
    expect(decodeActive(states.block('revoked'), true)).toBe(false);
    expect(decodeActive(states.overlay('lookup'), true)).toBe(false);
    expect(decodeActive(states.overlay('camera'), true)).toBe(true);
  });
});

describe('pendingBadge and readerChip', () => {
  it('counts queued and retrying rows, amber after 10 minutes', () => {
    const s = fixtureState({
      queue: { pending: 2, oldestAt: FIXTURE_NOW, conflicts: 0 },
      unsure: states.unsure().unsure,
    });
    expect(pendingBadge(s, FIXTURE_NOW + 599_999)).toEqual({ n: 3, late: false });
    expect(pendingBadge(s, FIXTURE_NOW + 600_001).late).toBe(true);
  });

  it('shows paused when the window lost focus, layout after three bad bursts', () => {
    const reader = { kind: 'barcode', lastAt: null, badLayout: 0 } as const;
    expect(readerChip(fixtureState())).toBeNull();
    expect(readerChip(fixtureState({ reader }))).toBe('ready');
    expect(readerChip(fixtureState({ reader, focused: false }))).toBe('paused');
    expect(readerChip(fixtureState({ reader: { ...reader, badLayout: 3 } }))).toBe('layout');
  });

  it('shows the no-read tip after a quiet spell with a reader set up', () => {
    const s = fixtureState({ reader: { kind: 'barcode', lastAt: null, badLayout: 0 } });
    expect(readerNoRead(s, FIXTURE_NOW + SCAN_TIMING.READER_NO_READ_HINT - 1)).toBe(false);
    expect(readerNoRead(s, FIXTURE_NOW + SCAN_TIMING.READER_NO_READ_HINT)).toBe(true);
    expect(readerNoRead(fixtureState(), FIXTURE_NOW + 60_000)).toBe(false);
  });
});
