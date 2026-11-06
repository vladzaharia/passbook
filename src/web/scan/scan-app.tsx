import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { z } from 'zod';
import { localZone } from '@/web/lib/timezones.ts';
import type { ScanAdminScopeSchema } from '../../shared/contracts/scan.ts';
import { errorMessage } from '../lib/errors.ts';
import { Button } from '../ui/button.tsx';
import { createLazyScanApi } from './api/lazy-api.ts';
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

function ScanBoot() {
  const csrf = useMemo(createCsrfHolder, []);
  const params = new URLSearchParams(location.search);
  const orgId = params.get('orgId');
  const eventId = params.get('eventId');
  const scope = useRef<z.infer<typeof ScanAdminScopeSchema> | undefined>(
    orgId
      ? {
          orgId,
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
  if (session.phase === 'ready' && session.session && !preview) {
    if (session.session.scanner?.deviceRole !== 'scan' && session.session.scanner !== null)
      return (
        <ScanShell
          cardMode="boot"
          card={
            <BootCard
              title="This device is a screen"
              line="Pair a scanning device to check in passes."
            />
          }
        />
      );
    if (session.session.state === 'staff_required')
      return (
        <ScanShell
          cardMode="boot"
          card={
            <BootCard
              title="Staff sign-in required"
              line="Ask an administrator to turn off staff sign-in for this scanner."
            />
          }
        />
      );
    if (session.session.state === 'unassigned')
      return (
        <ScanShell
          cardMode="boot"
          card={
            <BootCard title="Not set up" line="Assign templates in Scanning.">
              <Button onClick={() => void session.refetch()}>Try again</Button>
            </BootCard>
          }
        />
      );
    return (
      <Paired
        key={`${session.session.scanner?.id ?? 'admin'}:${session.session.counts.configRev}:${session.session.event?.id ?? ''}`}
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
  ) : session.phase === 'scope_required' ? (
    <AdminStart
      onScope={(chosen) => {
        scope.current = chosen;
        const query = new URLSearchParams({ orgId: chosen.orgId, timeZone: chosen.timeZone });
        if (chosen.eventId) query.set('eventId', chosen.eventId);
        if (chosen.templateIds?.length) query.set('templateIds', chosen.templateIds.join(','));
        history.replaceState(null, '', `/scan?${query}`);
        void session.refetch();
      }}
    />
  ) : session.phase === 'loading' ? (
    <BootCard title="Loading scanner…" />
  ) : session.phase === 'error' || session.phase === 'blocked' ? (
    <BootCard title="Scanner unavailable" line="Check the connection and try again.">
      <Button onClick={() => void session.refetch()}>Try again</Button>
    </BootCard>
  ) : (
    <PairView onPair={previewPair} error={error} busy={busy} />
  );
  return <ScanShell cardMode="boot" card={card} />;
}

export function ScanApp() {
  return (
    <Suspense fallback={<ScanShell cardMode="boot" card={<BootCard title="Loading scanner…" />} />}>
      <ScanBoot />
    </Suspense>
  );
}
