import { Settings2, SlidersHorizontal } from 'lucide-react';
import type { ScanningDevice } from '@/shared/contracts/scanning-sessions.ts';
import { SCAN_SURFACE_LABELS } from '@/shared/scan-surfaces.ts';
import { Badge, Button, Card, CardBody, StatusPill } from '@/web/ui/index.ts';
import { RelTime, useNow } from '../../passes/detail/rel-time.tsx';
import { SURFACE_ICON } from './surface-picker.tsx';

export function DeviceCard({
  device,
  canManage,
  onConfigure,
}: {
  device: ScanningDevice;
  canManage: boolean;
  onConfigure: () => void;
}) {
  const Icon =
    SURFACE_ICON[
      device.surface === 'auto' && !device.capabilities ? 'auto' : device.effectiveSurface
    ];
  const now = useNow();
  const overrides = Object.keys(device.overrides).length;
  return (
    <Card
      className={`min-w-0 overflow-hidden ${device.revoked ? 'opacity-60' : ''}`}
      data-testid="session-device"
    >
      <CardBody className="grid h-full min-w-0 grid-cols-1 gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="shrink-0 rounded-lg border border-border bg-surface-sunken p-3">
            <Icon aria-hidden className="size-6 text-fg-muted" />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="truncate font-semibold text-fg-strong">{device.name}</h3>
            <p className="text-xs text-fg-muted">
              {device.surface === 'auto'
                ? device.capabilities
                  ? `Automatic · ${SCAN_SURFACE_LABELS[device.effectiveSurface]}`
                  : 'Automatic · waiting for device'
                : SCAN_SURFACE_LABELS[device.effectiveSurface]}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <StatusPill
            status={
              device.revoked
                ? 'revoked'
                : device.online
                  ? 'online'
                  : device.paired
                    ? 'offline'
                    : 'not_paired'
            }
            tone={
              device.revoked
                ? 'danger'
                : device.online
                  ? 'success'
                  : device.paired
                    ? 'neutral'
                    : 'warning'
            }
          >
            {device.revoked
              ? 'Revoked'
              : device.online
                ? 'Online'
                : device.paired
                  ? 'Offline'
                  : 'Needs pairing'}
          </StatusPill>
          {device.signIn === 'admin' ? (
            <Badge>Admin · {device.adminName ?? 'Administrator'}</Badge>
          ) : null}
        </div>
        <div className="grid min-w-0 gap-1 text-xs text-fg-muted">
          <p>
            {device.capabilities
              ? `${device.capabilities.width} × ${device.capabilities.height}${device.capabilities.touch ? ' · Touch' : ''}`
              : 'Screen not reported yet'}
          </p>
          <p>
            {device.lastSeenAt ? (
              <>
                Last seen <RelTime at={device.lastSeenAt} now={now} />
              </>
            ) : (
              'Waiting for the first connection'
            )}
          </p>
          <p className="inline-flex items-center gap-1">
            <SlidersHorizontal className="size-3.5" aria-hidden />
            {overrides
              ? `${overrides} device override${overrides === 1 ? '' : 's'}`
              : 'Uses session defaults'}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          iconStart={<Settings2 aria-hidden />}
          onClick={onConfigure}
        >
          {canManage ? 'Configure device' : 'View device'}
        </Button>
      </CardBody>
    </Card>
  );
}
