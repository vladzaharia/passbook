import { describe, expect, it, vi } from 'vitest';
import { createWebNfcSource, type NdefReaderLike, tagOfReading, uidOf } from './web-nfc-source.ts';

const data = (text: string) => new DataView(new TextEncoder().encode(text).buffer);

describe('web nfc source', () => {
  it('turns a serial number into hex and rejects odd lengths', () => {
    expect(uidOf('04:A2:B3:C4:D5:E6:F7')).toBe('04a2b3c4d5e6f7');
    expect(uidOf('04:a2:b3')).toBeUndefined();
    expect(uidOf(undefined)).toBeUndefined();
  });

  it('reads the first url or text record and marks a 0x08 four-byte ID random', () => {
    expect(
      tagOfReading({
        serialNumber: '08:11:22:33',
        message: {
          records: [
            { recordType: 'mime', data: data('x') },
            { recordType: 'text', encoding: 'utf-8', data: data('Blue fob') },
          ],
        },
      }),
    ).toEqual({
      uid: '08112233',
      uidRandom: true,
      tech: 'unknown',
      ndef: { type: 'T', value: 'Blue fob' },
      source: 'webnfc',
    });
    const url = tagOfReading({
      message: { records: [{ recordType: 'url', data: data('https://x.test/t/a') }] },
    });
    expect(url.ndef).toEqual({ type: 'U', value: 'https://x.test/t/a' });
    expect(url.uid).toBeUndefined();
  });

  it('is unsupported without NDEFReader', () => {
    expect(createWebNfcSource(undefined).supported).toBe(false);
  });

  it('arms from a tap, emits readings as nfc tag reads and stops on cleanup', async () => {
    let reader!: NdefReaderLike;
    const scan = vi.fn(async () => undefined);
    class Fake implements NdefReaderLike {
      onreading: NdefReaderLike['onreading'] = null;
      onreadingerror: NdefReaderLike['onreadingerror'] = null;
      scan = scan;
      constructor() {
        reader = this;
      }
    }
    const source = createWebNfcSource(Fake);
    const emit = vi.fn();
    const stop = source.start(emit);
    expect(await source.arm()).toBe('on');
    reader.onreading?.({ serialNumber: '04:a2:b3:c4' });
    expect(emit).toHaveBeenCalledWith({
      method: 'nfc',
      tag: { uid: '04a2b3c4', tech: 'unknown', source: 'webnfc' },
    });
    reader.onreadingerror?.();
    expect(emit).toHaveBeenLastCalledWith({
      method: 'nfc',
      tag: { tech: 'unknown', source: 'webnfc' },
    });
    stop();
    expect(source.status()).toBe('idle');
  });

  it('reports a refused permission', async () => {
    class Denied implements NdefReaderLike {
      onreading = null;
      onreadingerror = null;
      scan = async () => {
        throw Object.assign(new Error('no'), { name: 'NotAllowedError' });
      };
    }
    expect(await createWebNfcSource(Denied).arm()).toBe('denied');
  });
});
