import { z } from 'zod';
import type { TagRead } from '../../../shared/contracts/nfc-tags.ts';
import type { RawRead } from './types.ts';

/** The bridge versions this page speaks. The app answers `ready` with the highest it shares. */
export const BRIDGE_VERSIONS = [1, 2] as const;
export const TAG_READ_MAX_MS = 60_000;

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

/** Native acknowledgement is emitted only after this exact read receives a server verdict. */
export function connectNativeReader(
  options: {
    read(read: RawRead): string | null;
    cancelled(inputId: string): void;
    unsupported(): void;
    capabilities?(value: Record<string, unknown>): void;
    /** A one-shot `tagRead` ended without a tag (sheet cancelled or timed out). */
    tagEnded?(why: 'cancelled' | 'timeout'): void;
  },
  bridge = (globalThis as { PassBookNative?: Bridge }).PassBookNative,
) {
  if (!bridge) return null;
  let pending: { nativeId: string; inputId: string } | null = null;
  /** Until the app answers `ready`, everything but `hello` speaks v1. */
  let version: 1 | 2 = 1;
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
  const cancel = () => {
    if (pending) options.cancelled(pending.inputId);
    pending = null;
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
      cancel();
      if (tagPending) {
        tagPending = null;
        options.tagEnded?.(message.event);
      }
      return;
    }
    if (message.event !== 'scan') return;
    const parsed = Scan.safeParse(message);
    if (!parsed.success) return;
    cancel();
    const scan = parsed.data;
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
      else pending = { nativeId: scan.id, inputId: tagInput };
      return;
    }
    if (scan.source === 'apple-vas') {
      sendResult(scan.id, 'error');
      options.unsupported();
      return;
    }
    const inputId = options.read({ method: scan.method ?? 'wedge', code: scan.value });
    if (!inputId) sendResult(scan.id, 'error');
    else pending = { nativeId: scan.id, inputId };
  };
  bridge.onmessage = onMessage;
  bridge.postMessage(JSON.stringify({ version: 2, op: 'hello', versions: [...BRIDGE_VERSIONS] }));
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
    start: () => send({ op: 'start', ...formats() }),
    result(inputId: string, outcome: ReaderOutcome) {
      if (pending?.inputId !== inputId) return false;
      sendResult(pending.nativeId, outcome);
      pending = null;
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
