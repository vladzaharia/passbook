import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  RollCall,
  RollCallMarksResponse,
  RollCallStatus,
} from '../../../shared/contracts/scan-roll-call.ts';
import { ApiError } from '../../lib/errors.ts';
import { connectDeviceSocket, deviceSocketUrl } from '../enroll/device-socket.ts';
import type { KeyValue } from '../offline/wipe.ts';
import { SCAN_TIMING } from '../timing.ts';
import { type QueuedMark, withQueue } from './roll-call-model.ts';
import { failsTaps, gone, isolate, stuck } from './roll-call-sync.ts';

export interface RollCallPort {
  current(call?: { signal?: AbortSignal }): Promise<{ rollCall: RollCall | null }>;
  start(): Promise<RollCall>;
  marks(id: string, marks: QueuedMark[]): Promise<RollCallMarksResponse>;
  end(id: string): Promise<RollCall>;
}

/** A tap the server could not take because the call had ended: shown to the desk, never dropped silently. */
export interface UnsavedMark {
  passId: string;
  status: RollCallStatus;
  name: string | null;
  /** Why, when the server kept refusing it (its code); absent when the call ended. */
  reason?: string;
}

const BATCH = 100;
/** Rounds of isolation in which a tap alone gets a 5xx before it is set aside. */
const SET_ASIDE_AFTER = 2;
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
  onBlocked,
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
  /** The server refused these taps (each with its code): they are dropped, and the desk is told why. */
  onRefused?: (items: { passId: string; code: string }[]) => void;
  /** The device as a whole may not sync (signed out, revoked): syncing stops until it is signed in again. */
  onBlocked?: (error: unknown) => void;
}) {
  const [server, setServer] = useState<RollCall | null>(null);
  const [queue, setQueue] = useState<QueuedMark[]>([]);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [asOf, setAsOf] = useState<number | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [stalled, setStalled] = useState(false);
  const [unsaved, setUnsaved] = useState<UnsavedMark[]>([]);
  const live = useRef({ server, queue, onAppear, onRefused, onBlocked, blocked, stalled });
  live.current = { server, queue, onAppear, onRefused, onBlocked, blocked, stalled };
  // Transient failures (network, 5xx) retry with a growing delay, never in a tight loop.
  const retry = useRef({ fails: 0, at: 0 });
  // The same 4xx or 5xx answer to the same first tap, over and over: after STUCK of them the batch is sent
  // one mark at a time, so the bad tap is found and the rest are saved.
  const repeats = useRef({ key: '', n: 0 });
  // Isolated 5xx answers per tap: one failing alone is retried before it is set aside.
  const strikes = useRef(new Map<string, number>());
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
    // A stall belongs to the call whose taps it holds.
    if (next?.id !== had) setStalled(false);
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
    const { server: call, queue: all, blocked: stopped, stalled: held } = live.current;
    const pending = all.filter((m) => m.callId === call?.id);
    if (stopped || held || sending.current || !call || pending.length === 0) return;
    if (Date.now() < retry.current.at) return;
    sending.current = true;
    const people = new Map(call.people.map((p) => [p.passId, p.holder]));
    const setAside = (marks: readonly { mark: QueuedMark; code?: string }[]) => {
      setUnsaved((u) => [
        ...u,
        ...marks.map(({ mark: m, code }) => ({
          passId: m.passId,
          status: m.status,
          name: people.get(m.passId) ?? null,
          ...(code === undefined ? {} : { reason: code }),
        })),
      ]);
      setQueue((q) => q.filter((m) => !marks.some((x) => x.mark === m)));
    };
    const told = (next: RollCallMarksResponse) => {
      // Refused taps, and Outs taken as a confirmation alone, are both told to the desk.
      const refused = next.results.filter((r) => r.status === 'refused' || r.code);
      if (refused.length)
        live.current.onRefused?.(refused.map((r) => ({ passId: r.passId, code: r.code ?? '' })));
    };
    const fail = async (error: unknown, batch: readonly QueuedMark[]): Promise<void> => {
      const status = error instanceof ApiError ? error.status : 0;
      if (gone(error)) {
        // The call ended under these taps. They are not lost silently: the desk is shown them to note down.
        setAside(batch.map((mark) => ({ mark })));
        setQueue([]);
        await reload();
      } else if (status === 401 || status === 403) {
        // Not this call's fault: the device itself may not act. Stop, and say so.
        setBlocked(true);
        setError(true);
        live.current.onBlocked?.(error);
      } else if (failsTaps(status) && stuck(repeats, status, error, batch)) {
        const one = await isolate((marks) => port.marks(call.id, marks), batch);
        repeats.current = { key: '', n: 0 };
        retry.current = { fails: 0, at: 0 };
        if (one.last) take(one.last, true);
        const saved = one.done.length > 0;
        // A 5xx to a tap alone is its fault only when other taps got through, and only on the second round:
        // the first leaves it queued to be tried again. With nothing through, the server is down.
        const key = (m: QueuedMark) => `${m.passId}:${m.status}:${m.at}`;
        const again = saved
          ? one.failed.filter((f) => {
              const n = (strikes.current.get(key(f.mark)) ?? 0) + 1;
              strikes.current.set(key(f.mark), n);
              return n >= SET_ASIDE_AFTER;
            })
          : [];
        const bad = [...one.bad, ...again];
        setQueue((q) => q.filter((m) => !one.done.includes(m)));
        setAside(bad.map((b) => ({ mark: b.mark, code: b.code || 'server' })));
        if (one.halt)
          await fail(
            one.halt,
            batch.filter((m) => !one.done.includes(m) && !bad.some((b) => b.mark === m)),
          );
        else if (!saved && one.failed.length > 0) {
          setStalled(true);
          setError(true);
        }
      } else {
        const fails = retry.current.fails + 1;
        retry.current = { fails, at: Date.now() + Math.min(60_000, 1000 * 2 ** fails) };
        setError(true);
      }
    };
    const batch = pending.slice(0, BATCH);
    try {
      const next = await port.marks(call.id, batch);
      retry.current = { fails: 0, at: 0 };
      setQueue((q) => q.filter((m) => !batch.includes(m)));
      repeats.current = { key: '', n: 0 };
      setStalled(false);
      told(next);
      take(next, true);
    } catch (error) {
      await fail(error, batch);
    } finally {
      sending.current = false;
    }
  }, [port, take, reload]);

  /** After the stall: try the taps again from the top. */
  const retryStalled = useCallback(() => {
    setStalled(false);
    live.current.stalled = false;
    repeats.current = { key: '', n: 0 };
    retry.current = { fails: 0, at: 0 };
    void flush();
  }, [flush]);

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
    // Nothing left to sync: there is nothing to stall on.
    if (queue.length === 0) setStalled(false);
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
  return {
    call,
    pending: queue.length,
    error,
    busy,
    asOf,
    blocked,
    stalled,
    retryStalled,
    unsaved,
    clearUnsaved: () => setUnsaved([]),
    mark,
    start,
    end,
    reload,
  };
}
export type RollCallState = ReturnType<typeof useRollCall>;
