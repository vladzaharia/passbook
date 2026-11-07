import { Check, CircleAlert, Monitor, ScanLine, TriangleAlert, Undo2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ScanSession } from '../../../shared/contracts/scan-session.ts';
import { ScanLiveMessageSchema, type ScanLiveRow } from '../../../shared/contracts/scan-setups.ts';
import { formatTime } from '../../lib/format.ts';
import { Buddy } from '../../ui/art/index.ts';
import { CustomerBuddy, type CustomerBuddyStatus } from './customer-buddy.tsx';
import './live-screen.css';
import { Button } from '../../ui/button.tsx';
import { ScanOrgLogo, scanBrandLogoUrl, scanBrandStyle } from '../platform/scan-branding.tsx';

const RESULT_ICON = {
  ok: Check,
  heads_up: TriangleAlert,
  refused: CircleAlert,
  ready: ScanLine,
  undo: Undo2,
};

function customerBuddyStatus(row: ScanLiveRow | undefined): CustomerBuddyStatus {
  if (!row) return 'ready';
  switch (row.kind) {
    case 'ok':
      return row.direction === 'out' ? 'checkedOut' : 'accepted';
    case 'ready':
      return 'review';
    case 'undo':
      return 'undone';
    case 'heads_up':
    case 'refused':
      return 'needsStaff';
  }
}

const CUSTOMER_HOLD_MS: Record<ScanLiveRow['kind'], number> = {
  ok: 4_000,
  heads_up: 6_000,
  refused: 6_000,
  ready: 60_000,
  undo: 2_400,
};
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
  const [buddyReplay, setBuddyReplay] = useState(0);
  const lastBuddyRow = useRef<string | null>(null);
  const customer = session.scanner?.deviceRole === 'customer';
  const branding = session.branding ?? null;
  const logoUrl = scanBrandLogoUrl(branding, session);
  const orgName = session.scanner?.orgName ?? '';
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
  const recent = rows.filter(
    (row) => now - row.at < (customer ? CUSTOMER_HOLD_MS[row.kind] : 15 * 60_000),
  );
  const latest = recent[0];
  const latestId = latest?.id;
  const latestAt = latest?.at;
  const latestKind = latest?.kind;
  useEffect(() => {
    if (!customer || latestId === undefined || latestAt === undefined || latestKind === undefined)
      return;
    const delay = Math.max(0, latestAt + CUSTOMER_HOLD_MS[latestKind] - Date.now()) + 1;
    const expiry = window.setTimeout(() => setNow(Date.now()), delay);
    return () => window.clearTimeout(expiry);
  }, [customer, latestId, latestAt, latestKind]);
  useEffect(() => {
    const id = latestId ?? null;
    if (lastBuddyRow.current === id) return;
    lastBuddyRow.current = id;
    setBuddyReplay((replay) => replay + 1);
  }, [latestId]);
  return (
    <main
      className="scan-live-page min-h-dvh bg-surface text-fg"
      style={scanBrandStyle(branding)}
      data-testid="scan-live"
      data-view={customer ? 'customer' : 'monitor'}
    >
      <header className="scan-live-header">
        <div className="scan-live-brand">
          <span className="scan-live-brand-icon" data-has-logo={logoUrl ? '' : undefined}>
            <ScanOrgLogo
              className="scan-live-logo"
              src={logoUrl}
              name={orgName}
              fallback={
                customer ? <ScanLine size={22} aria-hidden /> : <Monitor size={22} aria-hidden />
              }
            />
          </span>
          <div className="scan-live-brand-text">
            <p className="scan-live-eyebrow">{customer ? 'Customer display' : 'Desk monitor'}</p>
            <h1>{session.scanner?.name}</h1>
            <p className="scan-live-org">{session.scanner?.orgName}</p>
          </div>
        </div>
        <span role="status" className="scan-live-status" data-connected={connected}>
          {connected ? 'Live' : 'Reconnecting…'}
        </span>
      </header>
      {customer ? (
        <section
          aria-live="polite"
          className="scan-live-welcome"
          data-kind={latest?.kind ?? 'ready'}
        >
          <div className="scan-live-customer-copy">
            <p className="scan-live-eyebrow">{latest ? 'Pass scanned' : 'Ready to scan'}</p>
            <h2>{latest?.label ?? 'Ready'}</h2>
            {!latest ? (
              <p className="scan-live-welcome-hint">Present your pass to the scanner.</p>
            ) : null}
          </div>
          <div aria-hidden="true" className="scan-live-buddy">
            <CustomerBuddy
              className="scan-live-customer-buddy-art"
              status={customerBuddyStatus(latest)}
              replay={buddyReplay}
            />
          </div>
        </section>
      ) : (
        <section aria-label="Recent scans" className="scan-live-recent">
          <div className="scan-live-section-heading">
            <div>
              <p className="scan-live-eyebrow">Session activity</p>
              <h2>Recent scans</h2>
            </div>
          </div>
          {recent.length ? (
            <ol className="scan-live-grid">
              {recent.map((row) => {
                const Icon = RESULT_ICON[row.kind];
                return (
                  <li key={row.id} className="scan-live-row" data-kind={row.kind}>
                    <div className="scan-live-avatar">
                      {row.photoUrl ? (
                        <img src={row.photoUrl} alt={row.holder ?? 'Member'} />
                      ) : (
                        <ScanLine aria-hidden size={22} />
                      )}
                    </div>
                    <div className="scan-live-row-body">
                      <p className="scan-live-row-name">{row.holder ?? row.label}</p>
                      {row.holder ? <p className="scan-live-row-label">{row.label}</p> : null}
                      <p className="scan-live-row-meta">
                        {row.scannerName} · {formatTime(row.at, session.scanner?.timeZone)}
                      </p>
                    </div>
                    <span className="scan-live-result-icon" aria-hidden>
                      <Icon size={18} />
                    </span>
                  </li>
                );
              })}
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
      {customer ? null : (
        <footer className="scan-live-footer">
          <Button variant="outline" onClick={() => void refetch()}>
            Refresh setup
          </Button>
        </footer>
      )}
    </main>
  );
}
