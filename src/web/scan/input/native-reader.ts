import { z } from 'zod';
import type { RawRead } from './types.ts';

interface Bridge {
  postMessage(message: string): void;
  onmessage: ((event: { data: string }) => void) | null;
}
const Scan = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('barcode'),
    id: z.string().min(1).max(100),
    value: z.string().min(1).max(2048),
    method: z.enum(['wedge', 'nfc']).optional(),
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
  },
  bridge = (globalThis as { PassBookNative?: Bridge }).PassBookNative,
) {
  if (!bridge) return null;
  let pending: { nativeId: string; inputId: string } | null = null;
  const send = (message: object) => bridge.postMessage(JSON.stringify({ version: 1, ...message }));
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
    if (message?.version !== 1) return;
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
      return;
    }
    if (message.event !== 'scan') return;
    const parsed = Scan.safeParse(message);
    if (!parsed.success) return;
    cancel();
    const scan = parsed.data;
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
  send({ op: 'hello' });
  send({ op: 'stop' });
  return {
    start: () => send({ op: 'start' }),
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
      send({ op: 'stop' });
      lastCustomerStatus = { status: 'ready', inputId: null };
    },
    dispose: () => {
      if (bridge.onmessage !== onMessage) return;
      cancel();
      send({ op: 'stop' });
      bridge.onmessage = null;
      lastCustomerStatus = { status: 'ready', inputId: null };
    },
  };
}
