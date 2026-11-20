/**
 * The device socket (T5, assumed): `GET /api/v1/scan/live?as=device`. It carries only `enroll`
 * messages, which hold an id and a time, never pass data. A message is a nudge: the device then
 * reads `GET /scan/tag-enrollments/pending`, which is the authority. The socket reconnects with a
 * back-off, and every open is a reason to read `pending` again.
 */
import { z } from 'zod';
import { ScanLiveResolvedSchema } from '../../../shared/contracts/scan-setups.ts';

const Enroll = z.object({
  enroll: z.object({
    id: z.string().min(1).max(100),
    expiresAt: z.number().optional(),
    cancelled: z.boolean().optional(),
  }),
});
const Resolved = z.object({ resolved: ScanLiveResolvedSchema });
const RollCallNudge = z.object({
  rollCall: z.object({ id: z.string().min(1).max(100), rev: z.number(), ended: z.boolean() }),
});
const Control = z.object({ control: z.literal('reset') });
export type DeviceNudge =
  | { kind: 'enroll'; id: string }
  | { kind: 'cancelled'; id: string }
  /** A desk let the person in whom this door refused (WP-G). */
  | { kind: 'resolved'; resolved: z.infer<typeof ScanLiveResolvedSchema> }
  /** A desk started, marked or ended a roll call: read it again. */
  | { kind: 'rollCall'; id: string; rev: number; ended: boolean }
  /** The hub reset the device: read the request again. */
  | { kind: 'reset' };

interface SocketLike {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(): void;
  readyState: number;
}
export type SocketCtor = new (url: string) => SocketLike;

export interface DeviceSocketDeps {
  url: string;
  onNudge(nudge: DeviceNudge): void;
  /** Every open, the first and each reconnect. */
  onOpen(): void;
  Socket?: SocketCtor;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export const BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000] as const;
export const PING_MS = 30_000;

export function connectDeviceSocket(deps: DeviceSocketDeps): { close(): void } {
  const Ctor = deps.Socket ?? (WebSocket as unknown as SocketCtor);
  const later = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const clear = deps.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let socket: SocketLike | null = null;
  let retry: unknown = null;
  let ping: unknown = null;
  let attempt = 0;
  let closed = false;

  const stopPing = () => {
    if (ping !== null) clear(ping);
    ping = null;
  };
  const schedulePing = () => {
    stopPing();
    ping = later(() => {
      if (socket?.readyState === 1) socket.send('ping');
      schedulePing();
    }, PING_MS);
  };
  function open() {
    if (closed) return;
    const s = new Ctor(deps.url);
    socket = s;
    s.onopen = () => {
      attempt = 0;
      schedulePing();
      deps.onOpen();
    };
    s.onmessage = ({ data }) => {
      if (typeof data !== 'string') return;
      let json: unknown;
      try {
        json = JSON.parse(data);
      } catch {
        return;
      }
      const enroll = Enroll.safeParse(json);
      if (enroll.success) {
        const { id, cancelled } = enroll.data.enroll;
        deps.onNudge({ kind: cancelled ? 'cancelled' : 'enroll', id });
        return;
      }
      const resolved = Resolved.safeParse(json);
      const roll = RollCallNudge.safeParse(json);
      if (resolved.success) deps.onNudge({ kind: 'resolved', resolved: resolved.data.resolved });
      else if (roll.success) deps.onNudge({ kind: 'rollCall', ...roll.data.rollCall });
      else if (Control.safeParse(json).success) deps.onNudge({ kind: 'reset' });
    };
    s.onclose = () => {
      stopPing();
      if (closed || socket !== s) return;
      socket = null;
      const wait = BACKOFF_MS[Math.min(attempt++, BACKOFF_MS.length - 1)] ?? 30_000;
      retry = later(() => {
        retry = null;
        open();
      }, wait);
    };
    s.onerror = () => s.close();
  }
  open();
  return {
    close() {
      closed = true;
      stopPing();
      if (retry !== null) clear(retry);
      const s = socket;
      socket = null;
      if (s) {
        s.onclose = null;
        s.close();
      }
    },
  };
}

export const deviceSocketUrl = (loc: { protocol: string; host: string }): string =>
  `${loc.protocol === 'https:' ? 'wss:' : 'ws:'}//${loc.host}/api/v1/scan/live?as=device`;
