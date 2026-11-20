import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RollCall, RollCallStatus } from '../../../shared/contracts/scan-roll-call.ts';
import { ApiError } from '../../lib/errors.ts';
import { connectDeviceSocket, deviceSocketUrl } from '../enroll/device-socket.ts';
import type { KeyValue } from '../offline/wipe.ts';
import { SCAN_TIMING } from '../timing.ts';
import { type QueuedMark, withQueue } from './roll-call-model.ts';

export interface RollCallPort {
  current(call?: { signal?: AbortSignal }): Promise<{ rollCall: RollCall | null }>;
  start(): Promise<RollCall>;
  marks(id: string, marks: QueuedMark[]): Promise<RollCall>;
  end(id: string): Promise<RollCall>;
}

/** A call the server closed under us, or one that is gone: drop the queue and start clean. */
const gone = (error: unknown) =>
  error instanceof ApiError && (error.code === 'ROLL_CALL_ENDED' || error.status === 404);

const BATCH = 100;
const QUEUE_KEY = 'roll-call-queue';

/**
 * The session's roll call. It reads on open, on a nudge from the hub and every 20 s, and keeps this device's
 * taps in a queue until the server has them, so a tap shows at once and survives a dropped connection.
 */
export function useRollCall({
  port,
  enabled,
  online,
  by,
  onAppear,
  connect = connectDeviceSocket,
  store,
  onRefused,
}: {
  port: RollCallPort;
  enabled: boolean;
  online: boolean;
  by: string;
  /** A call this device did not start has appeared: the sheet should open on it. */
  onAppear?: () => void;
  /** The device socket; tests pass a stub. */
  connect?: typeof connectDeviceSocket;
  /** Where unsent taps live across a reload; wiped when the scanner is unpaired. */
  store?: KeyValue<QueuedMark[]>;
  /** The server kept an Out because the person scanned since: the taps for it are dropped. */
  onRefused?: () => void;
}) {
  const [server, setServer] = useState<RollCall | null>(null);
  const [queue, setQueue] = useState<QueuedMark[]>([]);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [asOf, setAsOf] = useState<number | null>(null);
  const live = useRef({ server, queue, onAppear, onRefused });
  live.current = { server, queue, onAppear, onRefused };
  const sending = useRef(false);
  // The device's clock against the server's, measured on every read; taps carry the corrected time.
  const offset = useRef(0);
  const hydrated = useRef(store === undefined);
  useEffect(() => {
    if (!store) return;
    let alive = true;
    store.get(QUEUE_KEY).then(
      (saved) => {
        if (!alive) return;
        const id = live.current.server?.id;
        if (saved?.length) setQueue((q) => [...saved.filter((m) => !id || m.callId === id), ...q]);
        hydrated.current = true;
      },
      () => {
        hydrated.current = true;
      },
    );
    return () => {
      alive = false;
    };
  }, [store]);
  useEffect(() => {
    if (store && hydrated.current) void store.set(QUEUE_KEY, queue).catch(() => undefined);
  }, [store, queue]);

  const take = useCallback((next: RollCall | null, quiet = false) => {
    const had = live.current.server?.id;
    // A lower revision never replaces a higher one: a slow read must not undo a newer answer.
    if (next) offset.current = next.serverNow - Date.now();
    // Taps made on another call are history: they are never sent to this one.
    setQueue((q) => (next ? q.filter((m) => m.callId === next.id) : []));
    setServer((cur) => (next && cur && cur.id === next.id && cur.rev > next.rev ? cur : next));
    setAsOf(Date.now());
    setError(false);
    if (next && next.id !== had && !quiet) live.current.onAppear?.();
  }, []);

  const reload = useCallback(async () => {
    try {
      take((await port.current()).rollCall);
    } catch {
      setError(true);
    }
  }, [port, take]);

  const flush = useCallback(async () => {
    const { server: call, queue: all } = live.current;
    const pending = all.filter((m) => m.callId === call?.id);
    if (sending.current || !call || pending.length === 0) return;
    sending.current = true;
    const batch = pending.slice(0, BATCH);
    try {
      const next = await port.marks(call.id, batch);
      setQueue((q) => q.filter((m) => !batch.includes(m)));
      take(next, true);
    } catch (error) {
      if (gone(error)) {
        setQueue([]);
        await reload();
      } else if (error instanceof ApiError && error.code === 'ROLL_CALL_SCANNED_SINCE') {
        setQueue((q) => q.filter((m) => !batch.includes(m)));
        live.current.onRefused?.();
        await reload();
      } else setError(true);
    } finally {
      sending.current = false;
    }
  }, [port, take, reload]);

  useEffect(() => {
    if (!enabled || !online) return;
    void reload().then(flush);
    const t = setInterval(() => void reload().then(flush), SCAN_TIMING.COUNTS_POLL + 5000);
    const socket = connect({
      url: deviceSocketUrl(location),
      onOpen: () => void reload(),
      onNudge: (nudge) => {
        if (nudge.kind === 'rollCall') void reload();
      },
    });
    return () => {
      clearInterval(t);
      socket.close();
    };
  }, [enabled, online, reload, flush, connect]);

  useEffect(() => {
    if (online && queue.length > 0) void flush();
  }, [online, queue, flush]);

  const mark = useCallback((passId: string, status: RollCallStatus) => {
    const callId = live.current.server?.id;
    if (callId)
      setQueue((q) => [...q, { callId, passId, status, at: Date.now() + offset.current }]);
  }, []);

  const start = useCallback(async () => {
    setBusy(true);
    try {
      take(await port.start(), true);
      return true;
    } catch {
      setError(true);
      return false;
    } finally {
      setBusy(false);
    }
  }, [port, take]);

  const end = useCallback(async () => {
    const call = live.current.server;
    if (!call) return false;
    setBusy(true);
    try {
      await flush();
      await port.end(call.id);
      setServer(null);
      setQueue([]);
      return true;
    } catch (error) {
      if (gone(error)) await reload();
      else setError(true);
      return false;
    } finally {
      setBusy(false);
    }
  }, [port, flush, reload]);

  const call = useMemo(() => (server ? withQueue(server, queue, by) : null), [server, queue, by]);
  return { call, pending: queue.length, error, busy, asOf, mark, start, end, reload };
}
export type RollCallState = ReturnType<typeof useRollCall>;
