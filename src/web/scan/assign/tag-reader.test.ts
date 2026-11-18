import { describe, expect, it } from 'vitest';
import type { NativeScannerCapabilities } from '../../../shared/contracts/scanning-sessions.ts';
import { canTapToRead, tagReaderOf, WEDGE_UID } from './tag-reader.ts';

const native = (nfc: Partial<NativeScannerCapabilities['nfc']>) =>
  ({
    platform: 'ios',
    nfc: { available: true, reading: false, formats: ['tag-uid'], ...nfc },
  }) as NativeScannerCapabilities;
const web = (supported: boolean, status: 'idle' | 'on' = 'idle') => ({ supported, status });

describe('tagReaderOf', () => {
  it('Android reads continuously, iPhone per sheet', () => {
    expect(tagReaderOf(native({ continuous: true }), web(false), 'none').kind).toBe('continuous');
    expect(tagReaderOf(native({ continuous: false }), web(false), 'none')).toEqual({
      kind: 'sheet',
      needsStart: false,
    });
  });
  it('an app without tag formats reads no tags, even with Web NFC in the page', () => {
    expect(tagReaderOf(native({ formats: ['wallet-vas'] }), web(true), 'none').kind).toBe('none');
  });
  it('Chrome needs a tap to start NFC, then does not', () => {
    expect(tagReaderOf(undefined, web(true), 'none')).toEqual({ kind: 'webnfc', needsStart: true });
    expect(tagReaderOf(undefined, web(true, 'on'), 'none').needsStart).toBe(false);
  });
  it('a USB reader types; nothing else is none', () => {
    expect(tagReaderOf(undefined, web(false), 'barcode').kind).toBe('wedge');
    expect(tagReaderOf(undefined, web(false), 'none').kind).toBe('none');
  });
  it('only the sheet reader gets Tap to read', () => {
    expect(canTapToRead({ kind: 'sheet', needsStart: false })).toBe(true);
    expect(canTapToRead({ kind: 'continuous', needsStart: false })).toBe(false);
  });
  it('wedge IDs are 4, 7 or 10 bytes of hex', () => {
    expect(
      ['04A2B3C4', '04a2b3c4d5e6f7', '04a2b3c4d5e6f708aabb'].every((u) => WEDGE_UID.test(u)),
    ).toBe(true);
    expect(['04A2B3', 'CARD-0001', '04a2b3c4d5'].some((u) => WEDGE_UID.test(u))).toBe(false);
  });
});
