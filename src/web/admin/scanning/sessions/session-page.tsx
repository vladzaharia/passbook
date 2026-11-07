import { Copy, Pause, Play, Plus, ScanLine, Square } from 'lucide-react';
import { useState } from 'react';
import type { ScanningDevice } from '@/shared/contracts/scanning-sessions.ts';
import { revokeScannerConfirm } from '@/web/lib/confirms.ts';
import {
  Badge,
  Button,
  CheckboxField,
  ConfirmDialog,
  DropdownMenuItem,
  detailError,
  EmptyState,
  MoreMenu,
  PageHeader,
  SkeletonDetail,
  StatusPill,
  TwoPane,
  toast,
} from '@/web/ui/index.ts';
import { ModePill } from '@/web/ui/layout/mode-pill.tsx';
import { useScanner } from '../queries.ts';
import { PairDialog } from '../scanners/scanner-dialogs.tsx';
import { AddDeviceDialog } from './add-device-dialog.tsx';
import { useRevokeSessionDevice, useScanningSession, useUpdateSession } from './api.ts';
import { DeviceCard } from './device-card.tsx';
import { DeviceSheet } from './device-sheet.tsx';
import { SessionActivity } from './session-activity.tsx';
import { NewSessionDialog, SessionRulesDialog } from './session-dialog.tsx';
import { SessionSummary } from './session-summary.tsx';

export function ScanningSessionPage({
  sessionId,
  deviceId,
}: {
  sessionId: string;
  deviceId?: string;
}) {
  const query = useScanningSession(sessionId);
  const update = useUpdateSession(sessionId);
  const [dialog, setDialog] = useState<'rules' | 'add' | 'end' | 'duplicate'>();
  const [selected, setSelected] = useState<string | undefined>(deviceId);
  const [pairing, setPairing] = useState<string>();
  const [revoking, setRevoking] = useState<ScanningDevice>();
  const [showRevoked, setShowRevoked] = useState(false);
  const s = query.data;
  const device = s?.devices.find((d) => d.id === selected);
  const crumbs = [{ label: 'Scanning', to: '/admin/scanning' }, { label: s?.name ?? 'Session' }];
  if (query.isError)
    return detailError(query, {
      entity: 'scanner',
      to: '/admin/scanning',
      header: <PageHeader title="Scanning session" breadcrumbs={crumbs} />,
    });
  if (!s)
    return (
      <>
        <PageHeader title="Scanning session" breadcrumbs={crumbs} />
        <SkeletonDetail label="Loading scanning session" />
      </>
    );
  const active = s.status === 'active';
  const devices = s.devices.filter((d) => showRevoked || !d.revoked);
  async function change(status: 'active' | 'paused' | 'ended') {
    try {
      await update.mutateAsync({ status, revision: s?.updatedAt });
    } catch (error) {
      toast.error(error, 'Could not change session');
    }
  }
  return (
    <>
      <PageHeader
        title={s.name}
        breadcrumbs={crumbs}
        description={s.orgName}
        meta={
          <>
            <StatusPill
              status={s.status}
              tone={active ? 'success' : s.status === 'paused' ? 'warning' : 'neutral'}
            >
              {active ? 'Running' : s.status === 'paused' ? 'Paused' : 'Ended'}
            </StatusPill>
            <ModePill mode={s.mode} />
            <span>
              {s.onlineCount} online · {s.deviceCount} devices · {s.today} scans today
            </span>
          </>
        }
        actions={
          <>
            <Button
              iconStart={<Plus aria-hidden />}
              disabled={!active}
              onClick={() => setDialog('add')}
            >
              Add device
            </Button>
            <Button
              variant="outline"
              iconStart={<ScanLine aria-hidden />}
              disabled={!active}
              asChild
            >
              <a
                href={`/scan?admin=1&orgId=${encodeURIComponent(s.orgId)}&sessionId=${encodeURIComponent(s.id)}`}
              >
                Scan as Admin
              </a>
            </Button>
            <MoreMenu>
              <DropdownMenuItem onSelect={() => void change(active ? 'paused' : 'active')}>
                {active ? <Pause aria-hidden /> : <Play aria-hidden />}
                {active ? 'Pause session' : 'Resume session'}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setDialog('duplicate')}>
                <Copy aria-hidden />
                Duplicate session
              </DropdownMenuItem>
              {s.status !== 'ended' ? (
                <DropdownMenuItem destructive onSelect={() => setDialog('end')}>
                  <Square aria-hidden />
                  End session
                </DropdownMenuItem>
              ) : null}
            </MoreMenu>
          </>
        }
      />
      {!active ? (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning-border bg-warning-subtle p-4">
          <p className="text-sm">
            {s.status === 'paused'
              ? 'Check-ins are paused on every device.'
              : 'This session has ended.'}
          </p>
          <Button
            variant="outline"
            loading={update.isPending}
            onClick={() => void change('active')}
          >
            Resume session
          </Button>
        </div>
      ) : null}
      <TwoPane aside={<SessionSummary session={s} onEdit={() => setDialog('rules')} />}>
        <section className="grid gap-4" aria-labelledby="session-devices-title">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2
              id="session-devices-title"
              className="flex items-center gap-2 text-base font-semibold"
            >
              Devices <Badge>{s.deviceCount}</Badge>
            </h2>
            {s.devices.some((d) => d.revoked) ? (
              <CheckboxField
                label="Show revoked devices"
                checked={showRevoked}
                onCheckedChange={(checked) => setShowRevoked(checked === true)}
              />
            ) : null}
          </div>
          {devices.length ? (
            <div className="grid min-w-0 gap-4 sm:grid-cols-2">
              {devices.map((d) => (
                <DeviceCard key={d.id} device={d} onConfigure={() => setSelected(d.id)} />
              ))}
            </div>
          ) : (
            <EmptyState
              art="scanner"
              title="Add your first device"
              description="Pair a phone or display, or join with your administrator sign-in."
              action={
                <Button onClick={() => setDialog('add')} disabled={!active}>
                  Add device
                </Button>
              }
            />
          )}
        </section>
        <SessionActivity items={s.activity} />
      </TwoPane>
      {dialog === 'rules' ? (
        <SessionRulesDialog session={s} onClose={() => setDialog(undefined)} />
      ) : null}
      {dialog === 'add' ? (
        <AddDeviceDialog session={s} onClose={() => setDialog(undefined)} />
      ) : null}
      {dialog === 'duplicate' ? (
        <NewSessionDialog
          initial={s}
          onClose={() => setDialog(undefined)}
          onCreated={(id) => location.assign(`/admin/scanning/sessions/${id}`)}
        />
      ) : null}
      {dialog === 'end' ? (
        <ConfirmDialog
          open
          title="End scanning session?"
          description="Check-ins stop on every device. You can resume this session later."
          confirmLabel="End session"
          destructive
          onOpenChange={(open) => !open && setDialog(undefined)}
          onConfirm={async () => {
            await update.mutateAsync({ status: 'ended', revision: s.updatedAt });
            setDialog(undefined);
          }}
        />
      ) : null}
      {device ? (
        <DeviceSheet
          key={device.id}
          device={device}
          session={s}
          onClose={() => setSelected(undefined)}
          onPair={() => {
            setSelected(undefined);
            setPairing(device.id);
          }}
          onRevoke={() => {
            setSelected(undefined);
            setRevoking(device);
          }}
        />
      ) : null}
      {pairing ? <SessionPairDialog id={pairing} onClose={() => setPairing(undefined)} /> : null}
      {revoking ? (
        <SessionRevokeDialog device={revoking} onClose={() => setRevoking(undefined)} />
      ) : null}
    </>
  );
}
function SessionPairDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const query = useScanner(id);
  return <PairDialog scanner={query.data} onClose={onClose} />;
}
function SessionRevokeDialog({ device, onClose }: { device: ScanningDevice; onClose: () => void }) {
  const revoke = useRevokeSessionDevice(device.id);
  return (
    <ConfirmDialog
      open
      {...revokeScannerConfirm(device.name)}
      destructive
      onOpenChange={(open) => !open && onClose()}
      onConfirm={async () => {
        await revoke.mutateAsync();
        onClose();
      }}
    />
  );
}
