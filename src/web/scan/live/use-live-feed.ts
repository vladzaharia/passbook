import { useEffect, useState } from 'react';
import type { ScanPlaceRev } from '../../../shared/contracts/scan-occupancy.ts';
import type { ScanSession } from '../../../shared/contracts/scan-session.ts';
import {
  ScanLiveMessageSchema,
  type ScanLiveRow,
  type ScanPublicLiveRow,
} from '../../../shared/contracts/scan-setups.ts';
import { mergePlaces } from './monitor-model.ts';

/** Monitor and customer rows arrive without personal fields; the screens carry them as empty. */
function fullRow(row: ScanLiveRow | ScanPublicLiveRow): ScanLiveRow {
  return 'passId' in row
    ? row
    : { ...row, passId: null, holder: null, photoUrl: null, presented: true };
}

/** The live socket (polling while it is down): recent rows, counts, a welcome line. */
export function useLiveFeed(session: ScanSession, refetch: () => Promise<void>) {
  const [rows, setRows] = useState<ScanLiveRow[]>([]);
  const [places, setPlaces] = useState<ScanPlaceRev[]>([]);
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
    const reset = () => {
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
      if ('resolved' in parsed.data || 'enroll' in parsed.data) return;
      const snapshot = parsed.data;
      cursor = snapshot.cursor;
      if (snapshot.welcome !== undefined) setWelcome(snapshot.welcome);
      const incoming = snapshot.rows.map(fullRow);
      setPlaces((previous) =>
        mergePlaces(
          mergePlaces(previous, snapshot.places),
          incoming.flatMap((row) => row.places ?? []),
        ),
      );
      setRows((previous) => {
        const merged = new Map([...previous, ...incoming].map((row) => [row.id, row]));
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
  return { rows, places, welcome, connected, now, setNow };
}
