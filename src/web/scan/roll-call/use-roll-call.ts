import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RollCall, RollCallStatus } from '../../../shared/contracts/scan-roll-call.ts';
import { ApiError } from '../../lib/errors.ts';
import { connectDeviceSocket, deviceSocketUrl } from '../enroll/device-socket.ts';
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
}: {
  port: RollCallPort;
  enabled: boolean;
  online: boolean;
  by: string;
  /** A call this device did not start has appeared: the sheet should open on it. */
  onAppear?: () => void;
  /** The device socket; tests pass a stub. */
  connect?: typeof connectDeviceSocket;
}) {
  const [server, setServer] = useState<RollCall | null>(null);
  const [queue, setQueue] = useState<QueuedMark[]>([]);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [asOf, setAsOf] = useState<number | null>(null);
  const live = useRef({ server, queue, onAppear });
  live.current = { server, queue, onAppear };
  const sending = useRef(false);

  const take = useCallback((next: RollCall | null, quiet = false) => {
    const had = live.current.server?.id;
    // A lower revision never replaces a higher one: a slow read must not undo a newer answer.
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
    const { server: call, queue: pending } = live.current;
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
    setQueue((q) => [...q, { passId, status, at: Date.now() }]);
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
