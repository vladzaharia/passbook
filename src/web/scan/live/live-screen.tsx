import { Monitor } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ScanSession } from '../../../shared/contracts/scan-session.ts';
import type { ScanLiveRow } from '../../../shared/contracts/scan-setups.ts';
import { SCAN_COPY } from '../../../shared/copy/scan.ts';
import { CUSTOMER_COPY } from '../../../shared/copy/scan-customer.ts';
import { Button } from '../../ui/button.tsx';
import { CustomerStage } from '../customer-stage.tsx';
import type { StageTone } from '../customer-tone.ts';
import { ScanOrgLogo, scanBrandLogoUrl, scanBrandStyle } from '../platform/scan-branding.tsx';
import './live-screen.css';
import { Toaster, toast } from '../../ui/toaster.tsx';
import type { ScanApi } from '../api/scan-api.ts';
import { MonitorHardware } from '../hardware/hardware-control.tsx';
import {
  DRAFT_HOLD_MS,
  reviewAmount,
  settledDrafts,
  shownDraft,
  withoutReplacedReady,
} from './customer-draft.ts';
import { useMonitorBeat } from './monitor-beat.ts';
import { MonitorBoard } from './monitor-board.tsx';
import { deskActing, type OverrideNote, StaffControl, useLetIn } from './monitor-desk.tsx';
import { MonitorInside } from './monitor-inside.tsx';
import type { LetIn } from './monitor-model.ts';
import { useLeaving } from './use-leaving.ts';
import { useLiveFeed } from './use-live-feed.ts';

function stageTone(row: ScanLiveRow | undefined): StageTone {
  if (!row) return 'ready';
  switch (row.kind) {
    case 'ok':
      return row.direction === 'out' ? 'checkedOut' : 'accepted';
    case 'ready':
      return 'review';
    case 'undo':
      return 'undone';
    case 'heads_up':
      return 'attention';
    case 'refused':
      return 'rejected';
  }
}

const CUSTOMER_HOLD_MS: Record<ScanLiveRow['kind'], number> = {
  ok: 4_000,
  heads_up: 6_000,
  refused: 6_000,
  ready: 60_000,
  undo: 2_400,
};
const SETUP_HOLD_MS = 900;
/** Hooks run for every monitor; without an API there is nothing to call and the buttons never show. */
const NO_API = {} as ScanApi;
const SETUP_SHOW_MS = 12_000;

export function LiveScreen({
  session,
  refetch,
  api,
}: {
  session: ScanSession;
  refetch: () => Promise<void>;
  /** The device API: Desk actions need it. Without one the monitor only reads. */
  api?: ScanApi;
}) {
  const { rows, places, drafts, welcome, connected, now, setNow } = useLiveFeed(session, refetch);
  const [replay, setReplay] = useState(0);
  const [setup, setSetup] = useState(false);
  const [setupFocused, setSetupFocused] = useState(false);
  const [letInDone, setLetInDone] = useState<ReadonlyMap<string, LetIn>>(new Map());
  const [own, setOwn] = useState(0);
  const refresh = useRef<HTMLButtonElement>(null);
  const lastRow = useRef<string | null>(null);
  const hold = useRef<ReturnType<typeof setTimeout>>(undefined);
  const customer = session.scanner?.deviceRole === 'customer';
  const beat = useMonitorBeat(rows, own);
  const acting = Boolean(api) && !customer && deskActing(session);
  const onLetIn = (row: ScanLiveRow, id: string | null) => {
    if (row.scanId)
      setLetInDone((done) =>
        new Map(done).set(row.scanId ?? '', {
          who: session.staff?.name ?? '',
          id,
          at: Date.now(),
          note: null,
        }),
      );
    setOwn((n) => n + 1);
  };
  const undone = (row: ScanLiveRow) => {
    if (row.scanId)
      setLetInDone((done) => {
        const next = new Map(done);
        next.delete(row.scanId ?? '');
        return next;
      });
  };
  const desk = useLetIn(api ?? NO_API, onLetIn, undone);
  const noting = useRef(new Set<string>());
  const why = (scanId: string, note: OverrideNote) => {
    const id = letInDone.get(scanId)?.id;
    if (!id || !api || noting.current.has(scanId)) return;
    noting.current.add(scanId);
    void api
      .overrideNote(id, note)
      .then(() =>
        setLetInDone((done) => {
          const held = done.get(scanId);
          return held ? new Map(done).set(scanId, { ...held, note }) : done;
        }),
      )
      .catch((error: unknown) => toast.error(error, 'Could not save the reason'))
      .finally(() => noting.current.delete(scanId));
  };

  const branding = session.branding ?? null;
  const logoUrl = scanBrandLogoUrl(branding, session);
  const orgName = session.scanner?.orgName ?? '';
  const recent = (customer ? withoutReplacedReady(rows) : rows).filter(
    (row) => now - row.at < (customer ? CUSTOMER_HOLD_MS[row.kind] : 15 * 60_000),
  );
  const latest = recent[0];
  const draft = customer ? shownDraft(settledDrafts(drafts, rows), latest, now) : null;
  const held = useLeaving(draft?.view);
  const shown = held.value;
  const view = shown ?? latest?.customer ?? null;
  const draftAt = draft?.at;
  useEffect(() => {
    if (draftAt === undefined) return;
    const expiry = window.setTimeout(
      () => setNow(Date.now()),
      draftAt + DRAFT_HOLD_MS - Date.now() + 1,
    );
    return () => window.clearTimeout(expiry);
  }, [draftAt, setNow]);
  const latestId = latest?.id;
  const latestAt = latest?.at;
  const latestKind = latest?.kind;
  useEffect(() => {
    if (!customer || latestId === undefined || latestAt === undefined || latestKind === undefined)
      return;
    const delay = Math.max(0, latestAt + CUSTOMER_HOLD_MS[latestKind] - Date.now()) + 1;
    const expiry = window.setTimeout(() => setNow(Date.now()), delay);
    return () => window.clearTimeout(expiry);
  }, [customer, latestId, latestAt, latestKind, setNow]);
  useEffect(() => {
    const id = latestId ?? null;
    if (lastRow.current === id) return;
    lastRow.current = id;
    setReplay((n) => n + 1);
  }, [latestId]);
  useEffect(() => {
    if (!setup || setupFocused) return;
    const timer = setTimeout(() => setSetup(false), SETUP_SHOW_MS);
    return () => clearTimeout(timer);
  }, [setup, setupFocused]);
  useEffect(() => {
    if (setup) refresh.current?.focus();
  }, [setup]);
  useEffect(() => () => clearTimeout(hold.current), []);

  if (customer)
    return (
      <CustomerStage
        tone={shown && !held.leaving ? 'review' : stageTone(latest)}
        replay={replay}
        brandName={orgName || 'PassBook'}
        logoUrl={logoUrl}
        title={view ? view.band.headline : latest ? latest.label : (welcome ?? undefined)}
        amount={shown ? reviewAmount(shown) : undefined}
        leaving={held.leaving}
        eyebrow={view?.greet ?? undefined}
        hint={view?.band.sub ?? undefined}
        notice={connected ? null : CUSTOMER_COPY.reconnecting}
        style={scanBrandStyle(branding)}
      />
    );
  return (
    <main
      className="scan-live-page min-h-dvh bg-surface text-fg"
      style={scanBrandStyle(branding)}
      data-testid="scan-live"
      data-view="monitor"
    >
      <h1 className="sr-only">{session.scanner?.name ?? 'Monitor'}</h1>
      <header className="scan-live-header">
        {/* Setup is staff only: hold the name for a second, or press Enter on it. */}
        <button
          type="button"
          className="scan-live-brand"
          aria-label={`${[session.scanner?.name, orgName].filter(Boolean).join(' ')} setup options`}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            hold.current = setTimeout(() => setSetup(true), SETUP_HOLD_MS);
          }}
          onPointerUp={() => clearTimeout(hold.current)}
          onPointerLeave={() => clearTimeout(hold.current)}
          onPointerCancel={() => clearTimeout(hold.current)}
          onClick={(event) => {
            if (event.detail === 0) setSetup(true);
          }}
        >
          <span className="scan-live-brand-icon" data-has-logo={logoUrl ? '' : undefined}>
            <ScanOrgLogo
              className="scan-live-logo"
              src={logoUrl}
              name={orgName}
              fallback={<Monitor size={22} aria-hidden />}
            />
          </span>
          <span className="scan-live-brand-text">
            <span className="scan-live-name">{session.scanner?.name}</span>{' '}
            <span className="scan-live-org">{orgName}</span>
          </span>
        </button>
        {setup ? (
          <Button
            ref={refresh}
            variant="outline"
            onFocus={() => setSetupFocused(true)}
            onBlur={() => setSetupFocused(false)}
            onClick={() => void refetch()}
          >
            Refresh setup
          </Button>
        ) : null}
        {api ? <StaffControl session={session} api={api} refetch={refetch} /> : null}
        <span role="status" className="sr-only">
          {setup ? 'Setup options shown' : ''}
        </span>
        <MonitorHardware online={connected} />
        <span role="status" className="scan-live-status" data-connected={connected}>
          {connected ? 'Live' : SCAN_COPY.public.offlineLine}
        </span>
      </header>
      <MonitorBoard
        rows={recent}
        places={places}
        now={now}
        timeZone={session.scanner?.timeZone}
        beat={beat}
        letInDone={letInDone}
        onWhy={why}
        {...(acting && api
          ? {
              onLetIn: desk.letIn,
              inside: (
                <MonitorInside api={api} online={connected} onMarked={() => setOwn((n) => n + 1)} />
              ),
            }
          : {})}
      />
      {acting ? (
        <>
          <Toaster />
          {desk.sheet}
        </>
      ) : null}
    </main>
  );
}
