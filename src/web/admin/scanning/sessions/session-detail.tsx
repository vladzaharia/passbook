import { useNavigate } from '@tanstack/react-router';
import { Copy, Pause, Play, Plus, QrCode, ScanLine, Square } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { z } from 'zod';
import type {
  ScanningDevice,
  ScanningSession,
  ScanningSessionDetailSchema,
} from '@/shared/contracts/scanning-sessions.ts';
import {
  Badge,
  Button,
  CheckboxField,
  ConfirmDialog,
  DropdownMenuItem,
  EmptyState,
  MoreMenu,
  PageHeader,
  TwoPane,
  toast,
} from '@/web/ui/index.ts';
import { ModePill } from '@/web/ui/layout/mode-pill.tsx';
import { CreatedCallout, useCreated } from '../../passes/created.tsx';
import { AddDeviceDialog } from './add-device-dialog.tsx';
import { useUpdateSession } from './api.ts';
import { DeviceCard } from './device-card.tsx';
import { DeviceSheet } from './device-sheet.tsx';
import { PairSheet } from './pair-sheet.tsx';
import { SessionActivity } from './session-activity.tsx';
import { SessionPairDialog, SessionRevokeDialog } from './session-device-dialogs.tsx';
import { SessionRulesDialog } from './session-dialog.tsx';
import {
  HoursBanner,
  type HoursDialog,
  HoursDialogs,
  HoursMenuItems,
} from './session-hours-actions.tsx';
import { SessionStatePill } from './session-state.tsx';
import { SessionSummary } from './session-summary.tsx';
import { SessionTonight } from './session-tonight.tsx';

export function SessionDetail({
  session: s,
  deviceId,
  addDevice,
  canManage,
  onDuplicate,
}: {
  session: z.infer<typeof ScanningSessionDetailSchema>;
  deviceId: string | undefined;
  addDevice: boolean;
  canManage: boolean;
  onDuplicate: (session: ScanningSession) => void;
}) {
  const update = useUpdateSession(s.id);
  const setupNote = useCreated<string>(`scan-setup:${s.id}`);
  const [dialog, setDialog] = useState<'rules' | 'add' | 'pair' | 'end' | HoursDialog | undefined>(
    canManage && addDevice ? 'add' : undefined,
  );
  const navigate = useNavigate();
  useEffect(() => {
    if (addDevice)
      void navigate({
        to: '.',
        search: (prev) => ({ ...prev, addDevice: undefined }),
        replace: true,
      });
  }, [addDevice, navigate]);
  const [selected, setSelected] = useState<string | undefined>(deviceId);
  const [pairing, setPairing] = useState<string>();
  const [revoking, setRevoking] = useState<ScanningDevice>();
  const [showRevoked, setShowRevoked] = useState(false);
  const device = s?.devices.find((d) => d.id === selected);
  const crumbs = [{ label: 'Scanning', to: '/admin/scanning' }, { label: s.name }];
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
        meta={
          <>
            <SessionStatePill session={s} />
            <ModePill mode={s.mode} />
            <span>
              {s.status === 'ended' ? 'Stopped' : `${s.onlineCount} online`} · {s.deviceCount}{' '}
              {s.deviceCount === 1 ? 'device' : 'devices'} · {s.today} done today
            </span>
          </>
        }
        actions={
          canManage ? (
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
                iconStart={<QrCode aria-hidden />}
                disabled={!active}
                onClick={() => setDialog('pair')}
              >
                Pair devices
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
                <DropdownMenuItem onSelect={() => onDuplicate(s)}>
                  <Copy aria-hidden />
                  Duplicate session
                </DropdownMenuItem>
                <HoursMenuItems session={s} onDialog={setDialog} />
                {s.status !== 'ended' ? (
                  <DropdownMenuItem destructive onSelect={() => setDialog('end')}>
                    <Square aria-hidden />
                    End session
                  </DropdownMenuItem>
                ) : null}
              </MoreMenu>
            </>
          ) : undefined
        }
      />
      {!active ? (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning-border bg-warning-subtle p-4">
          <p className="text-sm">
            {s.status === 'paused'
              ? 'Check-ins are paused on every device.'
              : 'This session has ended.'}
          </p>
          {canManage ? (
            <Button
              variant="outline"
              loading={update.isPending}
              onClick={() => void change('active')}
            >
              Resume session
            </Button>
          ) : null}
        </div>
      ) : null}
      {setupNote.shown && setupNote.mark ? (
        <div className="mb-6">
          <CreatedCallout title={setupNote.mark} onDismiss={setupNote.dismiss} />
        </div>
      ) : null}
      <HoursBanner session={s} canManage={canManage} onDialog={setDialog} />
      <TwoPane
        aside={
          <SessionSummary session={s} onEdit={canManage ? () => setDialog('rules') : undefined} />
        }
      >
        <section className="grid gap-4" aria-labelledby="session-devices-title">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2
                id="session-devices-title"
                className="flex items-center gap-2 text-base font-semibold"
              >
                Devices <Badge>{s.deviceCount}</Badge>
              </h2>
            </div>
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
                <DeviceCard
                  key={d.id}
                  device={d}
                  stopped={s.status === 'ended'}
                  canManage={canManage}
                  onConfigure={() => setSelected(d.id)}
                />
              ))}
            </div>
          ) : (
            <EmptyState
              art="scanner"
              title="Add your first device"
              action={
                canManage ? (
                  <Button onClick={() => setDialog('add')} disabled={!active}>
                    Add device
                  </Button>
                ) : undefined
              }
            />
          )}
        </section>
        {canManage ? <SessionTonight sessionId={s.id} /> : null}
        <SessionActivity items={s.activity} timeZone={s.timeZone} />
      </TwoPane>
      {canManage && dialog === 'rules' ? (
        <SessionRulesDialog session={s} onClose={() => setDialog(undefined)} />
      ) : null}
      {canManage ? (
        <HoursDialogs
          session={s}
          dialog={dialog === 'hold-open' || dialog === 'hold-close' ? dialog : undefined}
          onClose={() => setDialog(undefined)}
        />
      ) : null}
      {canManage && dialog === 'add' ? (
        <AddDeviceDialog
          session={s}
          setup={setupNote.mark !== undefined}
          deviceNames={s.devices.map((d) => d.name)}
          onClose={() => setDialog(undefined)}
        />
      ) : null}
      {canManage && dialog === 'pair' ? (
        <PairSheet sessionId={s.id} onClose={() => setDialog(undefined)} />
      ) : null}
      {canManage && dialog === 'end' ? (
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
          canManage={canManage}
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
      {canManage && pairing ? (
        <SessionPairDialog
          id={pairing}
          orgId={s.orgId}
          sessionId={s.id}
          onClose={() => setPairing(undefined)}
        />
      ) : null}
      {canManage && revoking ? (
        <SessionRevokeDialog device={revoking} onClose={() => setRevoking(undefined)} />
      ) : null}
    </>
  );
}
