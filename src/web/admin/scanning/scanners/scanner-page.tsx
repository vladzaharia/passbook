import { useNavigate } from '@tanstack/react-router';
import { Ban, FlaskConical, KeyRound, QrCode, ScanQrCode } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ENTITY } from '@/web/lib/entities.ts';
import {
  Button,
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
import { useScanner } from '../queries.ts';
import { useScanEvents } from '../scanner-api.ts';
import { acceptsText, scannerStatus } from './labels.ts';
import { DangerCard, DeviceCard, SettingsCard } from './scanner-cards.tsx';
import { GoLiveDialog, PairDialog, RevokeDialog, TokenDialog } from './scanner-dialogs.tsx';

type Dialog = 'pair' | 'revoke' | 'live' | 'token';

/** `/admin/scanning/scanners/$scannerId`: status up top, settings left, device and danger beside. */
export function ScannerPage({ scannerId }: { scannerId: string }) {
  const scanner = useScanner(scannerId);
  const navigate = useNavigate();
  const sessionId = scanner.data?.sessionId;
  useEffect(() => {
    if (sessionId)
      void navigate({
        to: '/admin/scanning/sessions/$sessionId',
        params: { sessionId },
        search: { deviceId: scannerId },
        replace: true,
      });
  }, [sessionId, scannerId, navigate]);
  const events = useScanEvents(scanner.data?.orgId, scanner.data?.accepts !== null);
  const now = useNow();
  const [dialog, setDialog] = useState<Dialog>();
  const crumbs = [
    { label: 'Scanning', to: '/admin/scanning' },
    { label: scanner.data?.name ?? 'Scanner' },
  ];
  if (scanner.isError) {
    return detailError(scanner, {
      entity: 'scanner',
      to: '/admin/scanning',
      header: <PageHeader title="Scanner" breadcrumbs={crumbs} />,
    });
  }
  const s = scanner.data;
  if (!s) {
    return (
      <>
        <PageHeader title="Scanner" breadcrumbs={crumbs} />
        <SkeletonDetail label="Loading scanner" />
      </>
    );
  }
  const revoked = s.status === 'revoked';
  const eventId = s.accepts && 'eventId' in s.accepts ? s.accepts.eventId : undefined;
  const eventName = events.data?.items.find((e) => e.id === eventId)?.name;
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
        }
      />
      <TwoPane
        aside={
          <>
            <DeviceCard scanner={s} now={now} />
            {revoked ? null : <DangerCard onRevoke={() => setDialog('revoke')} />}
          </>
        }
      >
        <SettingsCard key={`${s.id}:${s.status}`} scanner={s} />
      </TwoPane>
      {dialog === 'pair' ? <PairDialog scanner={s} onClose={close} /> : null}
      {dialog === 'revoke' ? <RevokeDialog scanner={s} onClose={close} /> : null}
      {dialog === 'live' ? <GoLiveDialog scanner={s} onClose={close} /> : null}
      {dialog === 'token' ? <TokenDialog scanner={s} onClose={close} /> : null}
    </>
  );
}
