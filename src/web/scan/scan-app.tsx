import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { z } from 'zod';
import { localZone } from '@/web/lib/timezones.ts';
import type { ScanAdminScopeSchema } from '../../shared/contracts/scan.ts';
import { errorMessage } from '../lib/errors.ts';
import { buttonVariants } from '../ui/button-variants.ts';
import { createLazyScanApi } from './api/lazy-api.ts';
import { useDeviceReport } from './boot/use-device-report.ts';
import { usePlatformAdmin } from './boot/use-platform-admin.ts';
import { createCsrfHolder, useScanSession } from './boot/use-scan-session.ts';
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
const LiveScreen = lazy(() =>
  import('./live/live-screen.tsx').then((m) => ({ default: m.LiveScreen })),
);

const StaffStart = lazy(() =>
  import('./boot/staff-start.tsx').then((m) => ({ default: m.StaffStart })),
);

function ScanBoot() {
  const { admin } = usePlatformAdmin();
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
          timeZone: params.get('timeZone') ?? localZone(),
          ...(eventId ? { eventId } : {}),
          ...(params.get('templateIds')
            ? { templateIds: params.get('templateIds')?.split(',') }
            : {}),
        }
      : undefined,
  );
  const api = useMemo(
    () => createLazyScanApi({ csrf: csrf.get, scope: () => scope.current }),
    [csrf],
  );
  const [machine, setMachine] = useState<ScanState | null>(null);
  const session = useScanSession(api, csrf, machine);
  useDeviceReport(api, session.session, session.refetch);
  const [preview, setPreview] = useState<{
    code: string;
    scannerName: string;
    orgName: string;
    mode: 'live' | 'test';
  } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const previewPair = useCallback(
    (code: string) => {
      setBusy(true);
      setError('');
      void api
        .pairPreview(code)
        .then(
          (data) => setPreview({ code, ...data }),
          (e) => setError(errorMessage(e)),
        )
        .finally(() => setBusy(false));
    },
    [api],
  );
  const pairTaken = useRef(false);
  useEffect(() => {
    if (session.pairCode && !pairTaken.current) {
      pairTaken.current = true;
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
                Scanning will be available when this session is resumed.
              </p>
              <button
                className={buttonVariants({ variant: 'outline' })}
                type="button"
                onClick={() => void session.refetch()}
              >
                Check session
              </button>
            </BootCard>
          }
        />
      );
    if (session.session.scanner?.deviceRole !== 'scan' && session.session.scanner !== null)
      return <LiveScreen session={session.session} refetch={session.refetch} />;
    if (session.session.state === 'staff_required')
      return (
        <ScanShell
          branding={session.session.branding}
          cardMode="boot"
          card={<StaffStart session={session.session} api={api} refetch={session.refetch} />}
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
  ) : adminStart && admin ? (
    <AdminStart
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
  ) : session.phase === 'error' || session.phase === 'blocked' ? (
    <BootCard title="Scanner unavailable" line="Check the connection and try again.">
      <button className={buttonVariants()} type="button" onClick={() => void session.refetch()}>
        Try again
      </button>
    </BootCard>
  ) : (
    <PairView
      onPair={previewPair}
      error={error}
      busy={busy}
      onAdmin={admin ? () => setAdminStart(true) : undefined}
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
