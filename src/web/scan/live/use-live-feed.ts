import { useEffect, useRef, useState } from 'react';
import type { ScanPlaceRev } from '../../../shared/contracts/scan-occupancy.ts';
import type { ScanSession } from '../../../shared/contracts/scan-session.ts';
import { ScanLiveMessageSchema, type ScanLiveRow } from '../../../shared/contracts/scan-setups.ts';
import { type Drafts, nextDrafts, settledDrafts } from './customer-draft.ts';
import { mergePlaces } from './monitor-model.ts';

/** The live socket (polling while it is down): recent rows, counts, a welcome line. */
/** How long a cancelled ready card is remembered: the ring keeps a row this long. */
const LIVE_ROW_TTL_MS = 15 * 60_000;

export function useLiveFeed(session: ScanSession, refetch: () => Promise<void>) {
  const [rows, setRows] = useState<ScanLiveRow[]>([]);
  /** The rows as the socket handler sees them: a late draft is checked against them. */
  const known = useRef<ScanLiveRow[]>([]);
  known.current = rows;
  const [places, setPlaces] = useState<ScanPlaceRev[]>([]);
  const [drafts, setDrafts] = useState<Drafts>(new Map());
  const [welcome, setWelcome] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [now, setNow] = useState(Date.now());
  const scope =
    session.principal === 'admin' && session.scanner
      ? new URLSearchParams({
          orgId: session.scanner.orgId,
          setupId: session.scanner.id,
          timeZone: session.scanner.timeZone,
        }).toString()
      : '';
  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let cursor: string | null = null;
    /** Ready cards a cancel dropped, by when: a later snapshot must not bring them back. */
    const cancelled = new Map<string, number>();
    const reset = () => {
      setDrafts(new Map());
      setRows([]);
      setPlaces([]);
    };
    const take = (data: unknown) => {
      const parsed = ScanLiveMessageSchema.safeParse(data);
      if (!parsed.success || disposed) return;
      if ('control' in parsed.data) {
        reset();
        setConnected(false);
        socket?.close();
        void refetch();
        return;
      }
      if ('draft' in parsed.data) {
        const message = parsed.data.draft;
        const at = Date.now();
        // A draft-only cancel (`keep`) leaves the ready card up, and a re-pick draws over it.
        if ('cancelled' in message && !message.keep) {
          for (const [ref, when] of cancelled)
            if (at - when > LIVE_ROW_TTL_MS) cancelled.delete(ref);
          cancelled.set(message.ref, at);
          setRows((previous) => previous.filter((row) => row.id !== message.ref));
        }
        setDrafts((previous) => settledDrafts(nextDrafts(previous, message, at), known.current));
        return;
      }
      if ('resolved' in parsed.data || 'enroll' in parsed.data) return;
      const snapshot = parsed.data;
      cursor = snapshot.cursor;
      setDrafts((previous) => settledDrafts(previous, snapshot.rows));
      if (snapshot.welcome !== undefined) setWelcome(snapshot.welcome);
      setPlaces((previous) =>
        mergePlaces(
          mergePlaces(previous, snapshot.places),
          snapshot.rows.flatMap((row) => row.places ?? []),
        ),
      );
      setRows((previous) => {
        const merged = new Map(
          [...previous, ...snapshot.rows.filter((row) => !cancelled.has(row.id))].map((row) => [
            row.id,
            row,
          ]),
        );
        return [...merged.values()]
          .sort((a, b) => b.at - a.at || b.id.localeCompare(a.id))
          .slice(0, 100);
      });
    };
    const connect = () => {
      if (disposed) return;
      setWelcome(null);
      socket = new WebSocket(
        `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/v1/scan/live${scope ? `?${scope}` : ''}`,
      );
      socket.onopen = () => {
        if (!disposed) setConnected(true);
      };
      socket.onmessage = (event) => {
        if (event.data === 'pong') return;
        try {
          take(JSON.parse(event.data));
        } catch {
          socket?.close(1002, 'Invalid message');
        }
      };
      socket.onclose = (event) => {
        if (disposed) return;
        setConnected(false);
        if (event.code === 4409 || event.code === 4401) {
          reset();
          void refetch();
        }
        retry = setTimeout(connect, 2000);
      };
      socket.onerror = () => socket?.close();
    };
    const controller = new AbortController();
    const poll = async () => {
      if (disposed || socket?.readyState === WebSocket.OPEN) return;
      try {
        const response = await fetch(
          `/api/v1/scan/live?${scope}${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`,
          { credentials: 'same-origin', cache: 'no-store', signal: controller.signal },
        );
        if (response.status === 401 || response.status === 403) {
          reset();
          await refetch();
        } else if (response.ok) take(await response.json());
      } catch (error) {
        if (!controller.signal.aborted) setConnected(false);
        if (error instanceof SyntaxError) socket?.close(1002, 'Invalid message');
      }
    };
    connect();
    const interval = setInterval(() => {
      setNow(Date.now());
      void poll();
      if (socket?.readyState === WebSocket.OPEN) socket.send('ping');
    }, 5000);
    return () => {
      disposed = true;
      controller.abort();
      clearInterval(interval);
      clearTimeout(retry);
      socket?.close();
    };
  }, [refetch, scope]);
  return { rows, places, drafts, welcome, connected, now, setNow };
}
