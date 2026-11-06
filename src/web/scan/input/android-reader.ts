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
  }),
  z.object({
    source: z.literal('apple-vas'),
    id: z.string().min(1).max(100),
    cryptogram: z.string().max(4096),
  }),
]);

/** Native acknowledgement is emitted only after this exact read receives a server verdict. */
export function connectAndroidReader(
  options: {
    read(read: RawRead): string | null;
    cancelled(inputId: string): void;
    unsupported(): void;
  },
  bridge = (globalThis as { PassBookNative?: Bridge }).PassBookNative,
) {
  if (!bridge) return null;
  let pending: { nativeId: string; inputId: string } | null = null;
  const send = (message: object) => bridge.postMessage(JSON.stringify({ version: 1, ...message }));
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
      send({ op: 'result', id: scan.id, outcome: 'error' });
      options.unsupported();
      return;
    }
    const inputId = options.read({ method: 'wedge', code: scan.value });
    if (!inputId) send({ op: 'result', id: scan.id, outcome: 'error' });
    else pending = { nativeId: scan.id, inputId };
  };
  bridge.onmessage = onMessage;
  send({ op: 'hello' });
  send({ op: 'stop' });
  return {
    result(inputId: string, outcome: 'accepted' | 'rejected' | 'error') {
      if (pending?.inputId !== inputId) return false;
      send({ op: 'result', id: pending.nativeId, outcome });
      pending = null;
      return true;
    },
    start: () => send({ op: 'start' }),
    stop: () => {
      cancel();
      send({ op: 'stop' });
    },
    dispose: () => {
      if (bridge.onmessage !== onMessage) return;
      cancel();
      send({ op: 'stop' });
      bridge.onmessage = null;
    },
  };
}
