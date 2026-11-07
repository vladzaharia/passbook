import { useEffect, useState } from 'react';
import type { ScanSession } from '../../../shared/contracts/scan-session.ts';
import { ScanLiveMessageSchema, type ScanLiveRow } from '../../../shared/contracts/scan-setups.ts';
import { formatTime } from '../../lib/format.ts';
import { Buddy } from '../../ui/art/buddy.tsx';
import './live-screen.css';
import { Button } from '../../ui/button.tsx';

export function LiveScreen({
  session,
  refetch,
}: {
  session: ScanSession;
  refetch: () => Promise<void>;
}) {
  const [rows, setRows] = useState<ScanLiveRow[]>([]);
  const [connected, setConnected] = useState(false);
  const [now, setNow] = useState(Date.now());
  const customer = session.scanner?.deviceRole === 'customer';
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
    const take = (data: unknown) => {
      const parsed = ScanLiveMessageSchema.safeParse(data);
      if (!parsed.success || disposed) return;
      if ('control' in parsed.data) {
        setRows([]);
        setConnected(false);
        socket?.close();
        void refetch();
        return;
      }
      const snapshot = parsed.data;
      cursor = snapshot.cursor;
      setRows((previous) => {
        const merged = new Map([...previous, ...snapshot.rows].map((row) => [row.id, row]));
        return [...merged.values()]
          .sort((a, b) => b.at - a.at || b.id.localeCompare(a.id))
          .slice(0, 100);
      });
    };
    const connect = () => {
      if (disposed) return;
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
          setRows([]);
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
          setRows([]);
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
  const recent = rows.filter((row) => now - row.at < (customer ? 10_000 : 15 * 60_000));
  const latest = recent[0];
  return (
    <main
      className="scan-live-page min-h-dvh bg-surface text-fg"
      data-testid="scan-live"
      data-view={customer ? 'customer' : 'monitor'}
    >
      <header className="scan-live-header flex items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-wider text-fg-muted">
            {customer ? 'Welcome' : 'Desk display'}
          </p>
          <h1 className="text-xl font-semibold">{session.scanner?.name}</h1>
          <p className="text-sm text-fg-muted">{session.scanner?.orgName}</p>
        </div>
        <span role="status" className="scan-live-status" data-connected={connected}>
          {connected ? 'Live' : 'Reconnecting…'}
        </span>
      </header>
      {customer ? (
        <section aria-live="polite" className="scan-live-welcome">
          <div className="scan-live-buddy">
            <Buddy scene="peek" size="lg" mood={latest?.kind === 'refused' ? 'flat' : 'happy'} />
          </div>
          <h2 className="text-4xl font-semibold sm:text-6xl">{latest?.label ?? 'Ready'}</h2>
          {!latest ? <p className="text-fg-muted">Present your pass to the scanner.</p> : null}
        </section>
      ) : (
        <section aria-label="Recent scans" className="scan-live-recent">
          <h2 className="mb-4 text-lg font-semibold">Recent scans</h2>
          {recent.length ? (
            <ol className="scan-live-grid">
              {recent.map((row) => (
                <li
                  key={row.id}
                  className="flex items-center gap-4 rounded-2xl border border-border bg-surface-raised p-5"
                >
                  {row.photoUrl ? (
                    <img
                      src={row.photoUrl}
                      alt={row.holder ?? 'Member'}
                      className="size-16 rounded-lg object-cover"
                    />
                  ) : null}
                  <div className="flex-1">
                    <p className="font-semibold">{row.holder ?? row.label}</p>
                    <p>{row.label}</p>
                    <p className="text-sm text-fg-muted">
                      {row.scannerName} · {formatTime(row.at, session.scanner?.timeZone)}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <div className="scan-live-empty">
              <div className="scan-live-buddy">
                <Buddy scene="peek" size="lg" mood="happy" />
              </div>
              <p className="font-medium">Ready for the first scan</p>
              <p className="text-sm text-fg-muted">Activity from this session appears here.</p>
            </div>
          )}
        </section>
      )}
      <footer className="scan-live-footer">
        <Button variant="outline" onClick={() => void refetch()}>
          Refresh setup
        </Button>
      </footer>
    </main>
  );
}
