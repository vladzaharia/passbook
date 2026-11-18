/**
 * How this device reads a tag (design 6.5). One answer the views and the runtime share:
 * `continuous` readers (Android app, Chrome Android after a tap) read without being asked,
 * `sheet` readers (iPhone, iPad) open the system sheet per read, `wedge` is a USB reader that types.
 */
import type { NativeScannerCapabilities } from '../../../shared/contracts/scanning-sessions.ts';

export type TagReaderKind = 'continuous' | 'sheet' | 'webnfc' | 'wedge' | 'none';

export interface TagReader {
  kind: TagReaderKind;
  /** Chrome Android: NFC must be started with a tap first. */
  needsStart: boolean;
}

export function tagReaderOf(
  native: NativeScannerCapabilities | undefined,
  webNfc: { supported: boolean; status: 'idle' | 'on' | 'denied' | 'error' },
  readerKind: 'none' | 'barcode' | 'nfc',
): TagReader {
  const formats = native?.nfc.formats ?? [];
  if (native && formats.includes('tag-uid'))
    return {
      kind: native.nfc.continuous === true ? 'continuous' : 'sheet',
      needsStart: false,
    };
  if (!native && webNfc.supported) return { kind: 'webnfc', needsStart: webNfc.status !== 'on' };
  // A USB reader types the tag ID like a barcode: only with a wedge reader set up.
  if (readerKind !== 'none') return { kind: 'wedge', needsStart: false };
  return { kind: 'none', needsStart: false };
}

/** A hex UID typed by a wedge reader (4, 7 or 10 bytes). */
export const WEDGE_UID = /^(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{14}|[0-9a-fA-F]{20})$/;

/** iPhone and iPad read at the desk only; Door gets Tap to read when the device has tag reading. */
export const canTapToRead = (reader: TagReader): boolean => reader.kind === 'sheet';
