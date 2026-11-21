import { useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import type { z } from 'zod';
import type { ScanRole } from '@/shared/contracts/scan.ts';
import type {
  ScanningDevice,
  ScanningSession,
  ScanningSessionDetailSchema,
} from '@/shared/contracts/scanning-sessions.ts';
import { Badge, Button, CheckboxField, EmptyState, PageHeader, TwoPane } from '@/web/ui/index.ts';
import { CreatedCallout, useCreated } from '../../passes/created.tsx';
import { AddDeviceDialog } from './add-device-dialog.tsx';
import { useUpdateSession } from './api.ts';
import { DeviceCard } from './device-card.tsx';
import { DeviceSheet } from './device-sheet.tsx';
import { PairSheet } from './pair-sheet.tsx';
import { EndSessionDialog } from './end-session-dialog.tsx';
import { SessionActions } from './session-actions.tsx';
import { SessionActivity } from './session-activity.tsx';
import { SessionChecks } from './session-checks.tsx';
import { SessionPairDialog, SessionRevokeDialog } from './session-device-dialogs.tsx';
import { SessionRulesDialog } from './session-dialog.tsx';
import { useSessionFixes } from './session-fixes.ts';
import { HoursBanner, type HoursDialog, HoursDialogs } from './session-hours-actions.tsx';
import { useSessionLive } from './session-live.ts';
import { SessionSetup } from './session-setup.tsx';
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
  const [adding, setAdding] = useState<ScanRole>();
  const live = useSessionLive(s);
  const fixes = useSessionFixes(s, live.staff.data?.items ?? [], {
    device: () => setDialog('add'),
    person: setAdding,
  });
  const device = s.devices.find((d) => d.id === selected);
  const crumbs = [{ label: 'Scanning', to: '/admin/scanning' }, { label: s.name }];
  const active = s.status === 'active';
  const devices = s.devices.filter((d) => showRevoked || !d.revoked);
  return (
    <>
      <PageHeader
        title={s.name}
        breadcrumbs={crumbs}
        meta={<SessionStatePill session={s} />}
        actions={
          canManage ? (
            <SessionActions
              session={s}
              onPair={() => setDialog('pair')}
              onDuplicate={() => onDuplicate(s)}
              onEnd={() => setDialog('end')}
            />
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
              onClick={() => void update.mutateAsync({ status: 'active', revision: s.updatedAt })}
            >
              Resume
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
          <>
            {canManage ? <SessionTonight sessionId={s.id} /> : null}
            <SessionChecks live={live} fixes={fixes} canManage={canManage} />
            <SessionSummary session={s} onEdit={canManage ? () => setDialog('rules') : undefined} />
          </>
        }
      >
        <SessionSetup
          session={s}
          live={live}
          canManage={canManage}
          adding={adding}
          setAdding={setAdding}
          onDialog={setDialog}
        />
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
        <EndSessionDialog session={s} onClose={() => setDialog(undefined)} />
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
