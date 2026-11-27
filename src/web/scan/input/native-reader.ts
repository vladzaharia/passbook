import { z } from 'zod';
import type { TagRead } from '../../../shared/contracts/nfc-tags.ts';
import type { RawRead } from './types.ts';

/** The bridge versions this page speaks. The app answers `ready` with the highest it shares. */
export const BRIDGE_VERSIONS = [1, 2] as const;
export const TAG_READ_MAX_MS = 60_000;
/** Additive `hello` features. Both sides ignore ones they do not know; the wire stays v2. */
export const BRIDGE_FEATURES = ['scanAck'] as const;
/** Scans that can await a verdict at once: a read during review or a result is held, not refused. */
const MAX_PENDING = 8;

interface Bridge {
  postMessage(message: string): void;
  onmessage: ((event: { data: string }) => void) | null;
}
const NativeTag = z.object({
  uid: z
    .string()
    .regex(/^(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{14}|[0-9a-fA-F]{20})$/)
    .optional(),
  uidRandom: z.boolean().optional(),
  tech: z.enum(['a', 'b', 'isodep', 'unknown']),
  ndef: z.object({ type: z.enum(['U', 'T']), value: z.string().min(1).max(1024) }).optional(),
});
const Scan = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('barcode'),
    id: z.string().min(1).max(100),
    value: z.string().min(1).max(2048),
    method: z.enum(['wedge', 'nfc']).optional(),
  }),
  z.object({
    source: z.literal('nfc-tag'),
    id: z.string().min(1).max(100),
    tag: NativeTag,
  }),
  z.object({
    source: z.literal('apple-vas'),
    id: z.string().min(1).max(100),
    cryptogram: z.string().max(4096),
  }),
]);

type ReaderOutcome = 'accepted' | 'rejected' | 'error';
type CustomerDisplayStatus =
  | 'ready'
  | 'checking'
  | 'accepted'
  | 'checkedOut'
  | 'rejected'
  | 'failed';
const CustomerDisplay = z.object({ supported: z.boolean(), available: z.boolean() });
const CustomerBranding = z.strictObject({
  name: z.string().trim().min(1).max(120),
  accent: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable(),
  logoSha: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
});

/** Receipt is acknowledged at once (`scanAck`); acceptance only after this exact read receives a server verdict. */
export function connectNativeReader(
  options: {
    read(read: RawRead): string | null;
    cancelled(inputId: string): void;
    unsupported(): void;
    capabilities?(value: Record<string, unknown>): void;
    /** The handshake settled whether the app takes v2 haptics (`scanAck` and `scanSettle` listed). */
    settleReady?(on: boolean): void;
    /** A one-shot `tagRead` ended without a tag (sheet cancelled or timed out). */
    tagEnded?(why: 'cancelled' | 'timeout'): void;
  },
  bridge = (globalThis as { PassBookNative?: Bridge }).PassBookNative,
) {
  if (!bridge) return null;
  /** Input id to native id, oldest first. A new scan no longer drops the one before it. */
  const pending = new Map<string, string>();
  /** Until the app answers `ready`, everything but `hello` speaks v1. */
  let version: 1 | 2 = 1;
  /** The app named `scanAck` in its `features`; until then it is never sent one. */
  let appAcks = false;
  /** The app named `scanSettle`: it plays no buzz of its own on `result`, so the page may send `haptic`. */
  let appSettles = false;
  let tagFormats = false;
  let tagSeq = 0;
  let tagPending: string | null = null;
  const send = (message: object) => bridge.postMessage(JSON.stringify({ version, ...message }));
  let customerDisplayAvailable = false;
  let lastCustomerStatus: {
    status: CustomerDisplayStatus;
    inputId: string | null;
  } = { status: 'ready', inputId: null };
  let customerBranding: z.infer<typeof CustomerBranding> | null = null;
  let sentBranding: string | null = null;
  const syncCustomerBranding = () => {
    if (!customerDisplayAvailable || !customerBranding) return false;
    const serialized = JSON.stringify(customerBranding);
    if (serialized === sentBranding) return false;
    send({ op: 'customerBranding', branding: customerBranding });
    sentBranding = serialized;
    return true;
  };
  const sendResult = (id: string, outcome: ReaderOutcome) => {
    send({ op: 'result', id, outcome });
  };
  const track = (inputId: string, nativeId: string) => {
    pending.set(inputId, nativeId);
    for (const oldest of pending.keys()) {
      if (pending.size <= MAX_PENDING) break;
      pending.delete(oldest);
    }
  };
  const cancel = () => {
    const inputs = [...pending.keys()];
    pending.clear();
    for (const inputId of inputs) options.cancelled(inputId);
  };
  const onMessage: NonNullable<Bridge['onmessage']> = ({ data }) => {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    if (message?.version !== 1 && message?.version !== 2) return;
    if (message.event === 'ready' && message.version === 2) version = 2;
    // A message newer than the handshake is not from the app we agreed a version with.
    if (message.version > version) return;
    if (message.event === 'ready' || message.event === 'capabilities') {
      if (Array.isArray(message.features)) {
        appAcks = message.features.includes('scanAck');
        appSettles = message.features.includes('scanSettle');
      } else if (message.event === 'ready') {
        appAcks = false;
        appSettles = false;
      }
      options.settleReady?.(version >= 2 && appAcks && appSettles);
      const capabilities = z.record(z.string(), z.unknown()).safeParse(message.capabilities);
      if (!capabilities.success) return;
      const display = CustomerDisplay.safeParse(capabilities.data.customerDisplay);
      const wasAvailable = customerDisplayAvailable;
      customerDisplayAvailable =
        display.success && display.data.supported && display.data.available;
      if (!wasAvailable && customerDisplayAvailable) sentBranding = null;
      options.capabilities?.(capabilities.data);
      if (!wasAvailable && customerDisplayAvailable && lastCustomerStatus.status !== 'ready')
        send({ op: 'customerStatus', status: lastCustomerStatus.status });
      syncCustomerBranding();
      return;
    }
    if (message.event === 'timeout' || message.event === 'cancelled') {
      // A `cancelled` naming the one-shot tag read ends that read only; a barcode check in flight stays.
      if (!(message.event === 'cancelled' && tagPending && message.id === tagPending)) cancel();
      if (tagPending) {
        tagPending = null;
        options.tagEnded?.(message.event);
      }
      return;
    }
    if (message.event !== 'scan') return;
    const parsed = Scan.safeParse(message);
    if (!parsed.success) return;
    const scan = parsed.data;
    // Receipt, before any verdict, only to an app that advertised it: it frees its gate on this.
    if (appAcks) send({ op: 'scanAck', id: scan.id });
    if (scan.source === 'nfc-tag') {
      // Tags need bridge v2. A v1 app never sends one, and a stray one is refused, not read.
      if (version < 2) {
        sendResult(scan.id, 'error');
        return;
      }
      tagPending = null;
      const tag: TagRead = {
        ...(scan.tag.uid ? { uid: scan.tag.uid.toLowerCase() } : {}),
        ...(scan.tag.uidRandom !== undefined ? { uidRandom: scan.tag.uidRandom } : {}),
        tech: scan.tag.tech,
        ...(scan.tag.ndef ? { ndef: scan.tag.ndef } : {}),
        source: 'native',
      };
      const tagInput = options.read({ method: 'nfc', tag });
      if (!tagInput) sendResult(scan.id, 'error');
      else track(tagInput, scan.id);
      return;
    }
    if (scan.source === 'apple-vas') {
      sendResult(scan.id, 'error');
      options.unsupported();
      return;
    }
    const inputId = options.read({ method: scan.method ?? 'wedge', code: scan.value });
    if (!inputId) sendResult(scan.id, 'error');
    else track(inputId, scan.id);
  };
  bridge.onmessage = onMessage;
  bridge.postMessage(
    JSON.stringify({
      version: 2,
      op: 'hello',
      versions: [...BRIDGE_VERSIONS],
      features: [...BRIDGE_FEATURES],
    }),
  );
  send({ op: 'stop' });
  const formats = () => (version >= 2 && tagFormats ? { formats: ['wallet-vas', 'tag'] } : {});
  return {
    /** The app speaks v2: tags can be read. */
    tags: () => version >= 2,
    /** Continuous tag reading with `start`/`stop` (Android). Takes effect on the next `start`. */
    setTagReading(on: boolean) {
      tagFormats = on;
    },
    /** One tag read, for readers that open a sheet per read (iOS). Null when the app is v1. */
    tagRead(prompt: string, timeoutMs = TAG_READ_MAX_MS): string | null {
      if (version < 2) return null;
      if (tagPending) send({ op: 'tagCancel', id: tagPending });
      tagPending = `tag-${++tagSeq}`;
      send({
        op: 'tagRead',
        id: tagPending,
        prompt,
        timeoutMs: Math.min(timeoutMs, TAG_READ_MAX_MS),
      });
      return tagPending;
    },
    tagCancel() {
      if (!tagPending) return;
      send({ op: 'tagCancel', id: tagPending });
      tagPending = null;
    },
    /** A buzz at the negotiated version. */
    haptic: (pattern: number[]) => send({ op: 'haptic', pattern }),
    start: () => send({ op: 'start', ...formats() }),
    result(inputId: string, outcome: ReaderOutcome) {
      const nativeId = pending.get(inputId);
      if (nativeId === undefined) return false;
      pending.delete(inputId);
      sendResult(nativeId, outcome);
      return true;
    },
    customerStatus(status: CustomerDisplayStatus, inputId: string | null = null) {
      const terminal = ['accepted', 'checkedOut', 'rejected', 'failed'].includes(
        lastCustomerStatus.status,
      );
      if (status === 'ready' && terminal) {
        lastCustomerStatus = { status, inputId: null };
        return false;
      }
      if (lastCustomerStatus.status === status && lastCustomerStatus.inputId === inputId)
        return false;
      lastCustomerStatus = { status, inputId };
      if (!customerDisplayAvailable) return false;
      send({ op: 'customerStatus', status });
      return true;
    },
    customerBranding(value: unknown) {
      const parsed = CustomerBranding.safeParse(value);
      if (!parsed.success) return false;
      customerBranding = parsed.data;
      return syncCustomerBranding();
    },
    readNfc: () => send({ op: 'nfcRead' }),
    stop: () => {
      cancel();
      tagPending = null;
      send({ op: 'stop', ...formats() });
      lastCustomerStatus = { status: 'ready', inputId: null };
    },
    dispose: () => {
      if (bridge.onmessage !== onMessage) return;
      cancel();
      send({ op: 'stop', ...formats() });
      bridge.onmessage = null;
      lastCustomerStatus = { status: 'ready', inputId: null };
    },
  };
}
