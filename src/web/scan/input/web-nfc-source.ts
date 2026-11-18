/**
 * Web NFC (Chrome on Android): `NDEFReader` reads a tag's serial number and its first URL or text
 * record. A tag with neither is reported as an empty read, so the assign flow can say it cannot
 * read it. The page must stay visible, and `scan()` needs a user gesture: `arm()` runs from a tap.
 */
import type { TagRead } from '../../../shared/contracts/nfc-tags.ts';
import type { InputSource, RawRead } from './types.ts';

interface NdefRecord {
  recordType: string;
  encoding?: string;
  data?: DataView;
}
interface NdefReadingEvent {
  serialNumber?: string;
  message?: { records?: readonly NdefRecord[] };
}
export interface NdefReaderLike {
  onreading: ((event: NdefReadingEvent) => void) | null;
  onreadingerror: (() => void) | null;
  scan(options?: { signal?: AbortSignal }): Promise<void>;
}
export type NdefReaderCtor = new () => NdefReaderLike;

export type WebNfcStatus = 'idle' | 'on' | 'denied' | 'error';

const UID = /^(?:[0-9a-f]{8}|[0-9a-f]{14}|[0-9a-f]{20})$/;
const MAX_NDEF_BYTES = 1024;

/** `04:A2:B3:C4` becomes `04a2b3c4`. Anything that is not a 4, 7 or 10 byte ID is none. */
export function uidOf(serialNumber: string | undefined): string | undefined {
  const hex = (serialNumber ?? '').replace(/[:\s-]/g, '').toLowerCase();
  return UID.test(hex) ? hex : undefined;
}

function ndefOf(records: readonly NdefRecord[] | undefined): TagRead['ndef'] {
  for (const record of records ?? []) {
    const kind =
      record.recordType === 'url' || record.recordType === 'absolute-url'
        ? 'U'
        : record.recordType === 'text'
          ? 'T'
          : null;
    if (!kind || !record.data || record.data.byteLength > MAX_NDEF_BYTES) continue;
    try {
      const value = new TextDecoder(record.encoding || 'utf-8').decode(record.data);
      if (value) return { type: kind, value };
    } catch {
      // An encoding the browser does not know: try the next record.
    }
  }
  return undefined;
}

export function tagOfReading(event: NdefReadingEvent): TagRead {
  const uid = uidOf(event.serialNumber);
  const ndef = ndefOf(event.message?.records);
  return {
    ...(uid ? { uid } : {}),
    // A 4-byte ID that starts with 0x08 is a random ID (phones, DESFire RandomID).
    ...(uid && uid.length === 8 && uid.startsWith('08') ? { uidRandom: true } : {}),
    tech: 'unknown',
    ...(ndef ? { ndef } : {}),
    source: 'webnfc',
  };
}

export interface WebNfcSource extends InputSource {
  readonly supported: boolean;
  /** Starts the reader. Call it from a tap. */
  arm(): Promise<WebNfcStatus>;
  status(): WebNfcStatus;
}

export function createWebNfcSource(
  ctor: NdefReaderCtor | undefined = (globalThis as { NDEFReader?: NdefReaderCtor }).NDEFReader,
): WebNfcSource {
  let emit: ((read: RawRead) => void) | null = null;
  let abort: AbortController | null = null;
  let status: WebNfcStatus = 'idle';
  const stop = () => {
    abort?.abort();
    abort = null;
    emit = null;
    status = 'idle';
  };
  return {
    method: 'nfc',
    supported: ctor !== undefined,
    status: () => status,
    start(next) {
      emit = next;
      return stop;
    },
    async arm() {
      if (!ctor) return 'error';
      if (status === 'on') return 'on';
      abort = new AbortController();
      try {
        const reader = new ctor();
        reader.onreading = (event) => emit?.({ method: 'nfc', tag: tagOfReading(event) });
        reader.onreadingerror = () =>
          emit?.({ method: 'nfc', tag: { tech: 'unknown', source: 'webnfc' } });
        await reader.scan({ signal: abort.signal });
        status = 'on';
      } catch (error) {
        abort = null;
        status = (error as { name?: string })?.name === 'NotAllowedError' ? 'denied' : 'error';
      }
      return status;
    },
  };
}
