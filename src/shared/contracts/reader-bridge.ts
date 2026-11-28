import { z } from 'zod';
import { TimestampSchema } from './common.ts';

/**
 * The `nfcReaders` bridge feature (wire v2, additive like `tagProgram`): external NFC readers as reader
 * slots. Native code is transport, framing and the APDU allow-lists below; tag logic lives in the page.
 * Both sides list the feature in `features`; neither sends these messages otherwise.
 */
export const NFC_READERS_FEATURE = 'nfcReaders';

/** At most this many readers on one device. */
export const READERS_MAX = 4;
/** The app ends a card session this long after the last page message. */
export const READER_SESSION_MS = 10_000;
/** `program` arming is refused when `expiresAt` is further ahead than this, or already past. */
export const READER_PROGRAM_MAX_AHEAD_MS = 5 * 60_000;

const Hex = z
  .string()
  .regex(/^(?:[0-9a-fA-F]{2})+$/)
  .max(520);
const Id = z.string().min(1).max(100);

export const READER_ERROR_CODES = [
  'READER_NOT_FOUND',
  'READER_PERMISSION',
  'READER_BT_OFF',
  'READER_DISCONNECTED',
  'READER_NOT_PAIRED',
  'READER_AUTH_MODE',
  'READER_LOCKED',
  'READER_UNSUPPORTED',
  'READER_UNENCRYPTED',
  'READER_BUSY',
  'APDU_REFUSED',
  'CARD_LOST',
] as const;
export const ReaderErrorCodeSchema = z.enum(READER_ERROR_CODES);
export type ReaderErrorCode = z.infer<typeof ReaderErrorCodeSchema>;

export const ReaderModelSchema = z.enum(['acr1555u', 'acr1552u', 'ccid']);
export const ReaderTransportSchema = z.enum(['usb', 'bluetooth', 'web-bluetooth']);

/** One reader as the app reports it. Unknown fields are dropped, so an older page keeps parsing. */
export const ReaderStateSchema = z.object({
  /** Opaque: `r-` plus 8 hex of SHA-256(install salt, serial) in the apps. Never a serial or a MAC. */
  id: Id,
  model: ReaderModelSchema,
  transport: ReaderTransportSchema,
  state: z.enum([
    'connecting',
    'ready',
    'card',
    'standby',
    'disconnected',
    'off',
    'needs-permission',
    'error',
  ]),
  /** The one reader cards are read from. */
  active: z.boolean(),
  mode: z.enum(['app', 'keyboard', 'unknown']),
  pinned: z.boolean(),
  /** Firmware allows `FF 00 00 00`. */
  passThrough: z.boolean(),
  /** Model plus the last 4 of the serial: the one serial fragment kept. */
  label: z.string().max(40).optional(),
  firmware: z.string().max(32).optional(),
  battery: z
    .strictObject({
      percent: z.number().int().min(0).max(100).nullable(),
      low: z.boolean(),
      charging: z.boolean().nullable(),
    })
    .optional(),
  code: ReaderErrorCodeSchema.optional(),
});
export type ReaderState = z.infer<typeof ReaderStateSchema>;

/** Web to app. */
export const ReaderOpSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('readerDiscover'),
    id: Id,
    transport: z.literal('bluetooth'),
    timeoutMs: z.number().int().positive().max(30_000),
  }),
  z.object({ op: z.literal('readerPair'), id: Id, handle: Id }),
  z.object({ op: z.literal('readerForget'), reader: Id }),
  z.object({
    op: z.literal('readerMode'),
    id: Id,
    reader: Id,
    mode: z.enum(['app', 'keyboard']),
  }),
  /** Names the active reader and the allow-list for its next card sessions. Resets after every `hello`. */
  z.discriminatedUnion('intent', [
    z.object({ op: z.literal('readerArm'), reader: Id, intent: z.literal('read') }),
    z.object({
      op: z.literal('readerArm'),
      reader: Id,
      intent: z.literal('program'),
      /** The server's program hold id (`modules/nfc/program-hold.ts`). */
      hold: Id,
      expiresAt: TimestampSchema,
    }),
  ]),
  z.object({
    op: z.literal('readerApdu'),
    id: Id,
    session: Id,
    apdus: z.array(Hex).min(1).max(32),
  }),
  /** Powers the card off; the next session waits for removal. */
  z.object({ op: z.literal('readerCardDone'), session: Id }),
]);
export type ReaderOp = z.infer<typeof ReaderOpSchema>;

/** App to web. */
export const ReaderEventSchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal('readers'), readers: z.array(ReaderStateSchema).max(READERS_MAX) }),
  /** iOS, per peripheral; `handle` is per scan and opaque. */
  z.object({
    event: z.literal('readerFound'),
    id: Id,
    handle: Id,
    name: z.string().max(100),
  }),
  z.object({ event: z.literal('readerPaired'), id: Id, reader: ReaderStateSchema }),
  /** Answers a discover, pair or mode op with `id`, or arrives unsolicited with `reader`. */
  z
    .object({
      event: z.literal('readerError'),
      id: Id.optional(),
      reader: Id.optional(),
      code: ReaderErrorCodeSchema,
    })
    .refine((e) => e.id !== undefined || e.reader !== undefined, 'Name the op or the reader.'),
  z.object({ event: z.literal('readerModeSet'), id: Id, reader: Id, ok: z.boolean() }),
  z.object({ event: z.literal('readerCard'), reader: Id, session: Id, atr: Hex }),
  z.object({ event: z.literal('readerCardGone'), reader: Id, session: Id }),
  /** One response per APDU sent, as far as the run got. `refused` names an APDU the allow-list stopped. */
  z.object({
    event: z.literal('readerApdu'),
    id: Id,
    session: Id,
    responses: z.array(Hex).max(32),
    refused: z.literal('APDU_REFUSED').optional(),
    code: z.enum(['CARD_LOST', 'READER_DISCONNECTED']).optional(),
  }),
]);
export type ReaderEvent = z.infer<typeof ReaderEventSchema>;

/** The program hold window: not past, and no more than five minutes ahead. */
export const programArmWindowOk = (expiresAt: number, nowMs: number): boolean =>
  expiresAt > nowMs && expiresAt - nowMs <= READER_PROGRAM_MAX_AHEAD_MS;

/** NTAG 424 native commands the `program` list wraps (`90 xx 00 00`): the set `program-script.ts` sends. */
export const PROGRAM_NATIVE_INS = [0x71, 0xaf, 0x60, 0x64, 0xf5, 0x5f, 0xc4, 0x8d, 0x3c] as const;
/** Native commands the `FF 00 00 00 Lc` pass-through may carry: read, read signature, get version, fast read. */
export const PASS_THROUGH_NATIVE = [0x30, 0x3a, 0x60, 0x3c] as const;

export type ReaderIntent = 'read' | 'program';
const toBytes = (hex: string): number[] | null =>
  /^(?:[0-9a-fA-F]{2})+$/.test(hex) && hex.length <= 520
    ? (hex.match(/../g) ?? []).map((b) => Number.parseInt(b, 16))
    : null;

/** `[Lc data] [Le]` after a 4-byte header: empty, Le only, or Lc plus data with an optional Le. */
function bodyWellFormed(b: number[]): boolean {
  const rest = b.length - 4;
  if (rest <= 1) return true;
  const lc = b[4] ?? 0;
  return rest === 1 + lc || rest === 2 + lc;
}

/**
 * The APDU allow-list as data plus one matcher; Java and Swift copy it with the shared vectors.
 * `read`: UID and ATS reads (`FF CA`), `FF B0` read binary, `FF 00 00 00` pass-through with a read
 * command (only when `passThrough`), ISO `00 A4` select and `00 B0` read binary. `program` adds the NTAG 424
 * native wraps. Escapes (`6B`), key loads, MIFARE auth, storage writes and every other `FF` are never relayed.
 */
export function isApduAllowed(
  hex: string,
  intent: ReaderIntent,
  options: { passThrough: boolean },
): boolean {
  const b = toBytes(hex);
  if (!b || b.length < 4) return false;
  const [cla, ins, p1, p2] = b as [number, number, number, number];
  if (cla === 0xff) {
    if (ins === 0xca)
      return b.length === 5 && p2 === 0x00 && b[4] === 0x00 && (p1 === 0x00 || p1 === 0x01);
    if (ins === 0xb0) return b.length === 5 && p1 === 0x00;
    if (ins === 0x00 && p1 === 0x00 && p2 === 0x00 && options.passThrough) {
      const lc = b[4] ?? 0;
      return (
        lc >= 1 &&
        b.length === 5 + lc &&
        (PASS_THROUGH_NATIVE as readonly number[]).includes(b[5] ?? -1)
      );
    }
    return false;
  }
  if (cla === 0x00) return (ins === 0xa4 || ins === 0xb0) && bodyWellFormed(b);
  if (intent === 'program' && cla === 0x90 && p1 === 0x00 && p2 === 0x00)
    return (PROGRAM_NATIVE_INS as readonly number[]).includes(ins) && bodyWellFormed(b);
  return false;
}

/**
 * Web Bluetooth has no native layer, so the page's codec builds frames and refuses every escape (`6B`)
 * payload but these read-only ones: firmware, battery, communication mode read, standby option read.
 * Our page code never sends a key, auth-mode, standby, UI, keyboard or host-interface command; the apps
 * configure readers. This set binds honest code only: script injected into `/scan` holds the same granted
 * device. The control is the strict CSP and Trusted Types `/scan` ships (accepted residual risk R7).
 */
export const WEB_BLUETOOTH_ESCAPES = [
  'E000001800', // firmware version
  'E000005200', // battery
  'E000007700', // communication mode read
  'E000005000', // standby option read
] as const;
/** CCID message types the Web Bluetooth codec may frame: power on (`62`), power off (`63`), slot status (`65`), XfrBlock (`6F`, APDU allow-list applies). `6B` goes only through the escape set. */
export const WEB_BLUETOOTH_CCID_MESSAGES = ['62', '63', '65', '6F'] as const;

export const isWebBluetoothEscapeAllowed = (hex: string): boolean =>
  (WEB_BLUETOOTH_ESCAPES as readonly string[]).includes(hex.toUpperCase());
