import { describe, expect, it } from 'vitest';
import {
  isApduAllowed,
  isWebBluetoothEscapeAllowed,
  NFC_READERS_FEATURE,
  PROGRAM_NATIVE_INS,
  programArmWindowOk,
  READER_ERROR_CODES,
  ReaderErrorCodeSchema,
  ReaderEventSchema,
  ReaderOpSchema,
  ReaderStateSchema,
  WEB_BLUETOOTH_ESCAPES,
} from './reader-bridge.ts';

const hex = (n: number) => n.toString(16).padStart(2, '0');
const read = (apdu: string, passThrough = true) => isApduAllowed(apdu, 'read', { passThrough });
const program = (apdu: string) => isApduAllowed(apdu, 'program', { passThrough: true });

const state = {
  id: 'r-4f21a0b3',
  model: 'acr1555u',
  transport: 'bluetooth',
  state: 'ready',
  active: true,
  mode: 'app',
  pinned: true,
  pinnedBy: 'device',
  passThrough: true,
} as const;

describe('feature and codes', () => {
  it('names the feature and lists the twelve error codes', () => {
    expect(NFC_READERS_FEATURE).toBe('nfcReaders');
    expect(READER_ERROR_CODES).toHaveLength(12);
    expect(ReaderErrorCodeSchema.safeParse('READER_UNENCRYPTED').success).toBe(true);
    expect(ReaderErrorCodeSchema.safeParse('READER_OTHER').success).toBe(false);
  });
});

describe('ReaderState', () => {
  it('accepts a reader and drops unknown fields', () => {
    const parsed = ReaderStateSchema.parse({ ...state, serial: 'SECRET' });
    expect(parsed).toEqual(state);
  });

  it('takes printable ASCII text and a hashed reader id only', () => {
    const bad = (extra: object) => ReaderStateSchema.safeParse({ ...state, ...extra }).success;
    expect(bad({ label: 'ACR1555U ·4F21' })).toBe(false);
    expect(bad({ label: 'ACR1555U \u202Eevil' })).toBe(false);
    expect(bad({ label: 'a\nb' })).toBe(false);
    expect(bad({ firmware: '1.3\u0000' })).toBe(false);
    expect(bad({ label: 'ACR1555U 4F21', firmware: '1.3.1' })).toBe(true);
    expect(bad({ id: 'r-4F21A0B3' })).toBe(false);
    expect(bad({ id: 'r-4f21a0b' })).toBe(false);
    expect(bad({ id: 'serial-123' })).toBe(false);
    expect(bad({ pinnedBy: 'other' })).toBe(false);
    expect(
      ReaderEventSchema.safeParse({ event: 'readerFound', id: 'a', handle: 'h', name: 'AC\u202ER' })
        .success,
    ).toBe(false);
  });

  it('refuses an unknown model and an overlong label', () => {
    expect(ReaderStateSchema.safeParse({ ...state, model: 'acr122' }).success).toBe(false);
    expect(ReaderStateSchema.safeParse({ ...state, label: 'x'.repeat(41) }).success).toBe(false);
  });
});

describe('ops', () => {
  const ok = (op: unknown) => ReaderOpSchema.safeParse(op).success;
  it('parses every op', () => {
    expect(ok({ op: 'readerDiscover', id: 'a', transport: 'bluetooth', timeoutMs: 30_000 })).toBe(
      true,
    );
    expect(ok({ op: 'readerPair', id: 'a', handle: 'h' })).toBe(true);
    expect(ok({ op: 'readerForget', reader: 'r-1' })).toBe(true);
    expect(ok({ op: 'readerMode', id: 'a', reader: 'r-1', mode: 'keyboard' })).toBe(true);
    expect(ok({ op: 'readerArm', reader: 'r-1', intent: 'read' })).toBe(true);
    expect(ok({ op: 'readerApdu', id: 'a', session: 's', apdus: ['FFCA000000'] })).toBe(true);
    expect(ok({ op: 'readerCardDone', session: 's' })).toBe(true);
  });

  it('bounds discovery, modes and apdu lists', () => {
    expect(ok({ op: 'readerDiscover', id: 'a', transport: 'bluetooth', timeoutMs: 30_001 })).toBe(
      false,
    );
    expect(ok({ op: 'readerDiscover', id: 'a', transport: 'usb', timeoutMs: 1000 })).toBe(false);
    expect(ok({ op: 'readerMode', id: 'a', reader: 'r', mode: 'unknown' })).toBe(false);
    expect(ok({ op: 'readerApdu', id: 'a', session: 's', apdus: [] })).toBe(false);
    expect(ok({ op: 'readerApdu', id: 'a', session: 's', apdus: Array(33).fill('00') })).toBe(
      false,
    );
    expect(ok({ op: 'readerApdu', id: 'a', session: 's', apdus: ['0'] })).toBe(false);
    expect(ok({ op: 'readerApdu', id: 'a', session: 's', apdus: ['00'.repeat(261)] })).toBe(false);
  });

  it('arms program only with a hold and an expiry', () => {
    expect(ok({ op: 'readerArm', reader: 'r', intent: 'program' })).toBe(false);
    expect(ok({ op: 'readerArm', reader: 'r', intent: 'program', hold: 'h' })).toBe(false);
    expect(ok({ op: 'readerArm', reader: 'r', intent: 'program', hold: 'h', expiresAt: 5 })).toBe(
      true,
    );
    expect(ok({ op: 'readerArm', reader: 'r', intent: 'other' })).toBe(false);
  });

  it('keeps a program hold inside a five minute window', () => {
    expect(programArmWindowOk(1_000, 999)).toBe(true);
    expect(programArmWindowOk(300_999, 999)).toBe(true);
    expect(programArmWindowOk(301_000, 999)).toBe(false);
    expect(programArmWindowOk(999, 999)).toBe(false);
    expect(programArmWindowOk(500, 999)).toBe(false);
  });
});

describe('events', () => {
  const ok = (event: unknown) => ReaderEventSchema.safeParse(event).success;
  it('parses every event', () => {
    expect(ok({ event: 'readers', readers: [state] })).toBe(true);
    expect(ok({ event: 'readerFound', id: 'a', handle: 'h', name: 'ACR1555U' })).toBe(true);
    expect(ok({ event: 'readerPaired', id: 'a', reader: state })).toBe(true);
    expect(ok({ event: 'readerError', id: 'a', code: 'READER_NOT_FOUND' })).toBe(true);
    expect(ok({ event: 'readerError', reader: 'r', code: 'READER_LOCKED' })).toBe(true);
    expect(ok({ event: 'readerModeSet', id: 'a', reader: 'r', ok: true })).toBe(true);
    expect(ok({ event: 'readerCard', reader: 'r', session: 's', atr: '3B8F8001' })).toBe(true);
    expect(ok({ event: 'readerCardGone', reader: 'r', session: 's' })).toBe(true);
    expect(ok({ event: 'readerApdu', id: 'a', session: 's', responses: ['9000'] })).toBe(true);
  });

  it('bounds readers, names an error and limits apdu codes', () => {
    expect(ok({ event: 'readers', readers: Array(5).fill(state) })).toBe(false);
    expect(ok({ event: 'readerError', code: 'READER_LOCKED' })).toBe(false);
    expect(ok({ event: 'readerError', reader: 'r', code: 'NOPE' })).toBe(false);
    expect(
      ok({ event: 'readerApdu', id: 'a', session: 's', responses: [], refused: 'APDU_REFUSED' }),
    ).toBe(true);
    expect(
      ok({ event: 'readerApdu', id: 'a', session: 's', responses: [], code: 'CARD_LOST' }),
    ).toBe(true);
    expect(
      ok({ event: 'readerApdu', id: 'a', session: 's', responses: [], code: 'READER_LOCKED' }),
    ).toBe(false);
  });
});

describe('APDU allow-list: read', () => {
  it('allows UID and ATS reads', () => {
    expect(read('FFCA000000')).toBe(true);
    expect(read('ffca010000')).toBe(true);
    expect(read('FFCA020000')).toBe(false);
    expect(read('FFCA000001')).toBe(false);
    expect(read('FFCA0000')).toBe(false);
  });

  it('allows FF B0 reads with P1 00 only', () => {
    expect(read('FFB0000410')).toBe(true);
    expect(read('FFB0010410')).toBe(false);
    expect(read('FFB00004')).toBe(false);
  });

  it('allows pass-through of read commands only, and only when the firmware allows it', () => {
    expect(read('FF000000023004')).toBe(true);
    expect(read('FF00000003 3A0408'.replace(' ', ''))).toBe(true);
    expect(read('FF0000000160')).toBe(true);
    expect(read('FF000000023C00')).toBe(true);
    expect(read('FF0000000230' + '04', false)).toBe(false);
    expect(read('FF000000023004'.replace('30', 'A0'))).toBe(false);
    expect(read('FF000000023004'.replace('30', 'A2'))).toBe(false);
    expect(read('FF0000000330' + '04')).toBe(false);
    expect(read('FF0000000130')).toBe(false);
    expect(read('FF00000000')).toBe(false);
    expect(read('FF01000002' + '3004')).toBe(false);
  });

  it('pins Lc per pass-through command and refuses trailing bytes', () => {
    expect(read('FF0000000C60' + '00'.repeat(11))).toBe(false);
    expect(read('FF0000000C60' + '0A'.repeat(11))).toBe(false);
    expect(read('FF000000026004')).toBe(false);
    expect(read('FF000000016000')).toBe(false);
    expect(read('FF00000001' + '60' + '00')).toBe(false);
    expect(read('FF000000023004' + '00')).toBe(false);
    expect(read('FF000000023A04')).toBe(false);
    expect(read('FF000000033A040800')).toBe(false);
    expect(read('FF0000000130')).toBe(false);
    expect(read('FF000000033C0000')).toBe(false);
    expect(read('FF000000FF60' + '00'.repeat(255))).toBe(false);
  });

  it('allows ISO select and read binary, nothing else on class 00', () => {
    expect(read('00A4040007D276000085010100')).toBe(true);
    expect(read('00A4000C02E103')).toBe(true);
    expect(read('00B000000F')).toBe(true);
    expect(read('00D6000001AA')).toBe(false);
    expect(read('00A4040007D2760000850101')).toBe(true);
    expect(read('00A4040007D27600008501')).toBe(false);
    expect(read('00A4040007D27600008501010000')).toBe(false);
  });

  it('refuses key loads, MIFARE auth, writes, escapes and junk', () => {
    expect(read('FF82000006FFFFFFFFFFFF')).toBe(false);
    expect(read('FF860000050001006000')).toBe(false);
    expect(read('FFD6000410AABBCCDD')).toBe(false);
    expect(read('FF00480001')).toBe(false);
    expect(read('E000007700')).toBe(false);
    expect(read('6B')).toBe(false);
    expect(read('')).toBe(false);
    expect(read('zz')).toBe(false);
    expect(read('FFCA00000')).toBe(false);
    expect(read('FFCA000000'.padEnd(522, '0'))).toBe(false);
  });
});

describe('APDU allow-list: program', () => {
  it('refuses native wraps while the intent is read', () => {
    expect(read('9071000000')).toBe(false);
  });

  it.each(PROGRAM_NATIVE_INS)('allows the native wrap %#', (ins) => {
    expect(program(`90${hex(ins)}000000`)).toBe(true);
    expect(program(`90${hex(ins)}0000020102 00`.replace(' ', ''))).toBe(true);
  });

  it('refuses other instructions, parameters and malformed bodies', () => {
    expect(program('9051000000')).toBe(false);
    expect(program('90AD000000')).toBe(false);
    expect(program('9071010000')).toBe(false);
    expect(program('9071000100')).toBe(false);
    expect(program('907100000301')).toBe(false);
    expect(program('9171000000')).toBe(false);
    expect(program('FFCA000000')).toBe(true);
    expect(program('E000005200')).toBe(false);
  });
});

describe('Web Bluetooth escapes', () => {
  it('is exactly the four read-only commands', () => {
    expect([...WEB_BLUETOOTH_ESCAPES]).toEqual([
      'E000001800',
      'E000005200',
      'E000007700',
      'E000005000',
    ]);
    for (const e of WEB_BLUETOOTH_ESCAPES)
      expect(isWebBluetoothEscapeAllowed(e.toLowerCase())).toBe(true);
  });

  it('refuses key, auth-mode, standby, keyboard and host-interface commands', () => {
    for (const e of [
      'E0000076' + '00',
      'E0000077' + '01',
      'E0000048' + '3C',
      'E000005B00',
      'E0000090023000',
      'E0000093010' + '0',
      'E000000F00',
      'E000007300',
      'E00000730400',
      '',
    ])
      expect(isWebBluetoothEscapeAllowed(e)).toBe(false);
  });
});
