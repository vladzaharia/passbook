import { RefreshCw, Smartphone } from 'lucide-react';
import type { PassDevicesDto, PassSyncDeviceDto } from '@/shared/contracts/events.ts';
import type { PassDetailDto } from '@/shared/contracts/passes.ts';
import { useInsertHighlight } from '../../../lib/motion.ts';
import {
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  ErrorState,
  Handoff,
  IconButton,
  ListRow,
  ListRows,
  SkeletonRows,
  StatusPill,
} from '../../../ui/index.ts';
import { RelTime, useNow } from './rel-time.tsx';
import { RemovalProgress } from './removal-progress.tsx';
import { usePassDevices } from './sync-api.ts';
import { shortDevice } from './sync-model.ts';

const SYNC_PILL = {
  current: 'device_current',
  waiting: 'device_waiting',
  push_failing: 'push_failing',
  removed: 'device_removed',
  unknown: 'device_unknown',
} as const;

function pillOf(d: PassSyncDeviceDto, removing: boolean): string {
  return removing && d.removal ? `removal_${d.removal}` : SYNC_PILL[d.status];
}

function Meta({ d, now }: { d: PassSyncDeviceDto; now: number }) {
  const gone = d.registeredAt === null;
  return (
    <>
      <span className="block">
        {gone && d.unregisteredAt !== null ? (
          <>
            Left <RelTime at={d.unregisteredAt} now={now} />
          </>
        ) : d.registeredAt !== null ? (
          <>
            Added <RelTime at={d.registeredAt} now={now} />
          </>
        ) : null}
      </span>
      <span className="block">
        {d.lastFetch ? (
          <>
            Fetched v{d.lastFetch.version} ({d.lastFetch.httpStatus}){' '}
            <RelTime at={d.lastFetch.at} now={now} />
          </>
        ) : (
          'Never fetched'
        )}
      </span>
      <span className="block">
        {d.lastPush ? (
          <>
            {d.lastPush.ok ? 'Pushed' : 'Push failed'}
            {d.lastPush.version !== null ? ` v${d.lastPush.version}` : ''}
            {!d.lastPush.ok && d.lastPush.reason ? `: ${d.lastPush.reason}` : ''}{' '}
            <RelTime at={d.lastPush.at} now={now} />
          </>
        ) : (
          'No push yet'
        )}
      </span>
    </>
  );
}

function summary(data: PassDevicesDto): string {
  const live = data.devices.filter((d) => d.registeredAt !== null);
  if (live.length === 0) return 'No device has the pass';
  const current = live.filter((d) => d.status === 'current').length;
  return `${current} of ${live.length} ${live.length === 1 ? 'device' : 'devices'} up to date`;
}

/** One row per device: did it get the current version, and if not, why. */
export function DevicesTab({ pass, active }: { pass: PassDetailDto; active: boolean }) {
  const query = usePassDevices(pass.id, active);
  const now = useNow();
  const data = query.data;
  const fresh = useInsertHighlight(data?.devices.map((d) => d.device) ?? []);
  if (query.isError)
    return <ErrorState inline error={query.error} onRetry={() => void query.refetch()} />;
  const removing = data?.removal != null;
  return (
    <div className="grid min-w-0 gap-6">
      {data?.removal ? <RemovalProgress removal={data.removal} /> : null}
      <Card className="min-w-0">
        <CardHeader
          title="Devices"
          actions={
            <>
              {data ? (
                <span role="status" className="text-xs text-fg-muted tabular-nums">
                  {summary(data)}
                </span>
              ) : null}
              <IconButton
                size="sm"
                label="Reload devices"
                data-busy={query.isFetching ? 'spin' : undefined}
                icon={<RefreshCw aria-hidden />}
                onClick={() => void query.refetch()}
              />
            </>
          }
        />
        <Handoff loading={!data} skeleton={<SkeletonRows rows={2} label="Loading devices" />}>
          {data && data.devices.length === 0 ? (
            <EmptyState inline art="phone" title="No devices yet" />
          ) : (
            <CardBody>
              <ListRows label="Devices">
                {data?.devices.map((d) => (
                  <ListRow
                    key={d.device}
                    rowId={d.device}
                    isNew={fresh.has(d.device)}
                    leading={<Smartphone aria-hidden />}
                    title={
                      <span className="font-mono text-xs" title={d.device}>
                        {shortDevice(d.device)}
                      </span>
                    }
                    meta={<Meta d={d} now={now} />}
                    trailing={<StatusPill status={pillOf(d, removing)} />}
                  />
                ))}
              </ListRows>
            </CardBody>
          )}
        </Handoff>
      </Card>
    </div>
  );
}
