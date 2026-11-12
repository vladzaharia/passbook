import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Ban, FlaskConical, KeyRound, QrCode, ScanQrCode } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ScannerSetup } from '@/shared/contracts/scan-setups.ts';
import { ENTITY } from '@/web/lib/entities.ts';
import { useMode } from '@/web/lib/mode.ts';
import { useOrgScope, useResourceOrg } from '@/web/lib/org-filter.tsx';
import {
  Button,
  Callout,
  DetailNotFound,
  DropdownMenuItem,
  detailError,
  MetaLink,
  MoreMenu,
  PageHeader,
  SkeletonDetail,
  StatusPill,
  TwoPane,
} from '@/web/ui/index.ts';
import { ModePill } from '@/web/ui/layout/mode-pill.tsx';
import { RelTime, useNow } from '../../passes/detail/rel-time.tsx';
import { SCANNERS_POLL_MS, scannerQuery } from '../queries.ts';
import { useScanEvents } from '../scanner-api.ts';
import { acceptsText, scannerStatus } from './labels.ts';
import { DangerCard, DeviceCard, SettingsCard } from './scanner-cards.tsx';
import { GoLiveDialog, PairDialog, RevokeDialog, TokenDialog } from './scanner-dialogs.tsx';

type Dialog = 'pair' | 'revoke' | 'live' | 'token';

/** `/admin/scanning/scanners/$scannerId`: status up top, settings left, device and danger beside. */
export function ScannerPage({ scannerId }: { scannerId: string }) {
  const { hasExplicitOrg, requestedOrgId } = useOrgScope();
  return (
    <ScannerResource
      key={`${scannerId}:${hasExplicitOrg}:${requestedOrgId ?? ''}`}
      scannerId={scannerId}
    />
  );
}

function ScannerResource({ scannerId }: { scannerId: string }) {
  const scope = useOrgScope();
  const scanner = useQuery({
    ...scannerQuery(scannerId, SCANNERS_POLL_MS),
    refetchOnMount: 'always',
  });
  const s = scanner.data;
  const resourceScope = useResourceOrg(
    scanner.isFetchedAfterMount && !scanner.isError ? s?.orgId : undefined,
  );
  const crumbs = [{ label: 'Scanning', to: '/admin/scanning' }, { label: 'Scanner' }];
  const header = <PageHeader title="Scanner" breadcrumbs={crumbs} />;
  if (resourceScope === 'not-found') {
    return (
      <>
        {header}
        <DetailNotFound entity="scanner" to="/admin/scanning" back="scanning" />
      </>
    );
  }
  if (scanner.isError) {
    return detailError(scanner, {
      entity: 'scanner',
      to: '/admin/scanning',
      back: 'scanning',
      header,
    });
  }
  if (!s || resourceScope !== 'ready' || scope.orgId !== s.orgId) {
    return (
      <>
        {header}
        <SkeletonDetail label="Loading scanner" />
      </>
    );
  }
  const canManage = Boolean(scope.membership?.capabilities.includes('scanning:manage'));
  return (
    <ScannerDetail key={`${s.id}:${s.orgId}:${canManage}`} scanner={s} canManage={canManage} />
  );
}

function ScannerDetail({ scanner: s, canManage }: { scanner: ScannerSetup; canManage: boolean }) {
  const navigate = useNavigate();
  const mode = useMode();
  const sessionId = s.sessionId;
  useEffect(() => {
    if (sessionId)
      void navigate({
        to: '/admin/scanning/sessions/$sessionId',
        params: { sessionId },
        search: { deviceId: s.id },
        replace: true,
      });
  }, [sessionId, s.id, navigate]);
  const events = useScanEvents(s.orgId, s.accepts !== null && s.mode === mode);
  const now = useNow();
  const [dialog, setDialog] = useState<Dialog>();
  const crumbs = [{ label: 'Scanning', to: '/admin/scanning' }, { label: s.name }];
  const revoked = s.status === 'revoked';
  const eventId = s.accepts && 'eventId' in s.accepts ? s.accepts.eventId : undefined;
  const eventName = events.data?.items.find((e) => e.id === eventId && e.orgId === s.orgId)?.name;
  const close = () => setDialog(undefined);
  const pair = (
    <Button
      variant={s.status === 'paired' ? 'outline' : 'primary'}
      iconStart={<QrCode aria-hidden />}
      onClick={() => setDialog('pair')}
    >
      {s.status === 'paired' ? 'Pair again' : 'Pair'}
    </Button>
  );

  return (
    <>
      <PageHeader
        title={s.name}
        breadcrumbs={crumbs}
        meta={
          <>
            <StatusPill status={scannerStatus(s)} />
            <ModePill mode={s.mode} />
            <span>
              Last seen {s.lastSeenAt === null ? 'never' : <RelTime at={s.lastSeenAt} now={now} />}
            </span>
            <span className="inline-flex items-center gap-1.5">
              {eventId ? <ENTITY.event.icon aria-hidden className="size-4" /> : null}
              {acceptsText(s, eventName)}
            </span>
            <MetaLink
              to="/admin/scanning"
              search={{ tab: 'scans', scannerId: s.id }}
              icon={ScanQrCode}
            >
              Scans
            </MetaLink>
          </>
        }
        actions={
          canManage ? (
            <>
              {revoked || s.adminSession || s.kind === 'terminal' ? null : pair}
              {s.mode === 'test' && !revoked ? (
                <Button
                  variant="outline"
                  iconStart={<FlaskConical aria-hidden />}
                  onClick={() => setDialog('live')}
                >
                  Go live
                </Button>
              ) : null}
              <MoreMenu>
                {s.kind === 'terminal' && !revoked ? (
                  <DropdownMenuItem onSelect={() => setDialog('token')}>
                    <KeyRound aria-hidden />
                    Replace token
                  </DropdownMenuItem>
                ) : null}
                {revoked ? null : (
                  <DropdownMenuItem destructive onSelect={() => setDialog('revoke')}>
                    <Ban aria-hidden />
                    Revoke
                  </DropdownMenuItem>
                )}
              </MoreMenu>
            </>
          ) : undefined
        }
      />
      <TwoPane
        aside={
          <>
            <DeviceCard scanner={s} now={now} />
            {!canManage || revoked ? null : <DangerCard onRevoke={() => setDialog('revoke')} />}
          </>
        }
      >
        {canManage && s.mode !== mode ? (
          <Callout tone="info">
            Switch to {s.mode === 'test' ? 'Test' : 'Live'} mode to edit scanner settings.
          </Callout>
        ) : null}
        <SettingsCard
          key={`${s.id}:${s.status}:${mode}`}
          scanner={s}
          canManage={canManage && s.mode === mode}
        />
      </TwoPane>
      {dialog === 'pair' ? <PairDialog scanner={s} onClose={close} /> : null}
      {dialog === 'revoke' ? <RevokeDialog scanner={s} onClose={close} /> : null}
      {dialog === 'live' ? <GoLiveDialog scanner={s} onClose={close} /> : null}
      {dialog === 'token' ? <TokenDialog scanner={s} onClose={close} /> : null}
    </>
  );
}
