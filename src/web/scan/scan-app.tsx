import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { z } from 'zod';
import { DEFAULT_TIME_ZONE } from '@/shared/time-zone.ts';
import type { ScanAdminScopeSchema } from '../../shared/contracts/scan.ts';
import { SCAN_COPY } from '../../shared/copy/scan.ts';
import { errorMessage } from '../lib/errors.ts';
import { buttonVariants } from '../ui/button-variants.ts';
import { createLazyScanApi } from './api/lazy-api.ts';
import { needsPinReset } from './boot/pin-reset-state.ts';
import { useDeviceReport } from './boot/use-device-report.ts';
import { usePlatformSession } from './boot/use-platform-session.ts';
import { useScanManageAccess } from './boot/use-scan-manage-access.ts';
import { createCsrfHolder, useScanSession } from './boot/use-scan-session.ts';
import { useWindowEdge } from './boot/use-window-edge.ts';
import type { ScanState } from './machine/types.ts';
import { BootCard } from './ui/boot-card.tsx';
import { ScanShell } from './ui/scan-shell.tsx';

const PairView = lazy(() => import('./boot/pair-view.tsx').then((m) => ({ default: m.PairView })));
const PairConfirm = lazy(() =>
  import('./boot/pair-confirm.tsx').then((m) => ({ default: m.PairConfirm })),
);
const Paired = lazy(() => import('./paired.tsx').then((m) => ({ default: m.Paired })));
const AdminStart = lazy(() =>
  import('./boot/admin-start.tsx').then((m) => ({ default: m.AdminStart })),
);
const RoleUnlock = lazy(() =>
  import('./role/unlock-sheet.tsx').then((m) => ({ default: m.RoleUnlock })),
);
const LiveScreen = lazy(() =>
  import('./live/live-screen.tsx').then((m) => ({ default: m.LiveScreen })),
);

const ClosedCard = lazy(() =>
  import('./boot/closed-card.tsx').then((m) => ({ default: m.ClosedCard })),
);
const StaffPinReset = lazy(() =>
  import('./boot/staff-pin-reset.tsx').then((m) => ({ default: m.StaffPinReset })),
);

const StaffStart = lazy(() =>
  import('./boot/staff-start.tsx').then((m) => ({ default: m.StaffStart })),
);

function ScanBoot() {
  const platform = usePlatformSession();
  const canManage = useScanManageAccess(platform?.user.id);
  const csrf = useMemo(createCsrfHolder, []);
  const params = new URLSearchParams(location.search);
  const orgId = params.get('orgId');
  const eventId = params.get('eventId');
  const setupId = params.get('setupId');
  const [adminStart, setAdminStart] = useState(params.get('admin') === '1');
  const scope = useRef<z.infer<typeof ScanAdminScopeSchema> | undefined>(
    orgId && setupId
      ? {
          orgId,
          setupId,
          timeZone: params.get('timeZone') ?? DEFAULT_TIME_ZONE,
          ...(eventId ? { eventId } : {}),
          ...(params.get('templateIds')
            ? { templateIds: params.get('templateIds')?.split(',') }
            : {}),
        }
      : undefined,
  );
  const refresh = useRef<() => Promise<void>>(async () => {});
  const api = useMemo(
    () =>
      createLazyScanApi({
        csrf: csrf.get,
        scope: () => scope.current,
        refreshConfig: () => refresh.current(),
      }),
    [csrf],
  );
  const [machine, setMachine] = useState<ScanState | null>(null);
  const session = useScanSession(api, csrf, machine);
  refresh.current = session.refetch;
  useDeviceReport(api, session.session, session.refetch);
  useWindowEdge(session.session?.workspace?.session.window, session.refetch);
  const [preview, setPreview] = useState<{
    code: string;
    scannerName: string;
    sessionName: string | null;
    orgName: string;
    mode: 'live' | 'test';
  } | null>(null);
  const [error, setError] = useState('');
  const [failedCode, setFailedCode] = useState('');
  const [busy, setBusy] = useState(false);
  const previewPair = useCallback(
    (code: string) => {
      setBusy(true);
      setError('');
      void api
        .pairPreview(code)
        .then(
          (data) => setPreview({ code, ...data }),
          (e) => {
            setFailedCode(code);
            setError(errorMessage(e));
          },
        )
        .finally(() => setBusy(false));
    },
    [api],
  );
  const pairTaken = useRef<string | null>(null);
  useEffect(() => {
    if (session.pairCode && pairTaken.current !== session.pairCode) {
      pairTaken.current = session.pairCode;
      previewPair(session.pairCode);
    }
  }, [session.pairCode, previewPair]);
  if (session.phase === 'ready' && session.session && !preview && !adminStart) {
    if (session.session.workspace && session.session.workspace.session.status !== 'active')
      return (
        <ScanShell
          branding={session.session.branding}
          cardMode="boot"
          card={
            <BootCard
              title={
                session.session.workspace.session.status === 'paused'
                  ? 'Session paused'
                  : 'Session ended'
              }
              line={session.session.workspace.session.name}
            >
              <p className="text-sm text-fg-muted">
                {session.session.workspace.session.status === 'paused'
                  ? SCAN_COPY.sessionPaused.line
                  : SCAN_COPY.sessionEnded.line}
              </p>
              <button
                className={buttonVariants({ variant: 'outline' })}
                type="button"
                onClick={() => void session.refetch()}
              >
                {SCAN_COPY.sessionPaused.check}
              </button>
            </BootCard>
          }
        />
      );
    if (session.session.scanner?.deviceRole !== 'scan' && session.session.scanner !== null)
      return (
        <>
          <LiveScreen session={session.session} refetch={session.refetch} api={api} />
          {session.session.scanner?.kind === 'device' &&
          session.session.scanner.deviceRole === 'customer' ? (
            <Suspense fallback={null}>
              <RoleUnlock api={api} refetch={session.refetch} />
            </Suspense>
          ) : null}
        </>
      );
    if (session.session.state === 'staff_required')
      return (
        <ScanShell
          branding={session.session.branding}
          cardMode="boot"
          card={<StaffStart session={session.session} api={api} refetch={session.refetch} />}
        />
      );
    if (needsPinReset(session.session))
      return (
        <ScanShell
          branding={session.session.branding}
          cardMode="boot"
          card={
            <Suspense fallback={null}>
              <StaffPinReset session={session.session} api={api} refetch={session.refetch} />
            </Suspense>
          }
        />
      );
    if (session.session.state === 'unassigned')
      return (
        <ScanShell
          branding={session.session.branding}
          cardMode="boot"
          card={
            <BootCard title="Not set up" line="Assign templates in Scanning.">
              <button
                className={buttonVariants()}
                type="button"
                onClick={() => void session.refetch()}
              >
                Try again
              </button>
            </BootCard>
          }
        />
      );
    const hours = session.session.workspace?.session.window;
    if (hours && !hours.open)
      return (
        <ScanShell
          branding={session.session.branding}
          cardMode="boot"
          card={
            <Suspense fallback={null}>
              <ClosedCard session={session.session} api={api} refetch={session.refetch} />
            </Suspense>
          }
        />
      );
    return (
      <Paired
        key={session.session.scanner?.id ?? 'admin'}
        session={session.session}
        api={api}
        refetch={session.refetch}
        onMachine={setMachine}
      />
    );
  }
  const card = preview ? (
    <PairConfirm
      scannerName={preview.scannerName}
      sessionName={preview.sessionName}
      orgName={preview.orgName}
      mode={preview.mode}
      busy={busy}
      error={error}
      onCancel={() => setPreview(null)}
      onPair={() => {
        setBusy(true);
        void session
          .pair(preview.code)
          .then(
            () => setPreview(null),
            (e) => setError(errorMessage(e)),
          )
          .finally(() => setBusy(false));
      }}
    />
  ) : adminStart && platform ? (
    <AdminStart
      userId={platform.user.id}
      onCancel={() => {
        setAdminStart(false);
        history.replaceState(null, '', '/scan');
      }}
      onScope={(chosen) => {
        const query = new URLSearchParams({ orgId: chosen.orgId, timeZone: chosen.timeZone });
        if (chosen.setupId) query.set('setupId', chosen.setupId);
        location.assign(`/scan?${query}`);
      }}
    />
  ) : session.phase === 'loading' ? (
    <BootCard title="Loading scanner…" />
  ) : session.ended ? (
    <BootCard title={SCAN_COPY.sessionEnded.title} line={SCAN_COPY.sessionEnded.line}>
      <button className={buttonVariants()} type="button" onClick={() => void session.refetch()}>
        {SCAN_COPY.actions.tryAgain}
      </button>
    </BootCard>
  ) : session.phase === 'error' || session.phase === 'blocked' ? (
    <BootCard title="Scanner unavailable" line="Check the connection and try again.">
      <button className={buttonVariants()} type="button" onClick={() => void session.refetch()}>
        Try again
      </button>
    </BootCard>
  ) : (
    <PairView
      onPair={previewPair}
      initialCode={failedCode}
      error={error}
      busy={busy}
      onAdmin={canManage ? () => setAdminStart(true) : undefined}
      adminWho={platform?.user.name ?? platform?.user.primaryEmail}
    />
  );
  return <ScanShell branding={session.session?.branding} cardMode="boot" card={card} />;
}

export function ScanApp() {
  return (
    <Suspense fallback={<ScanShell cardMode="boot" card={<BootCard title="Loading scanner…" />} />}>
      <ScanBoot />
    </Suspense>
  );
}
