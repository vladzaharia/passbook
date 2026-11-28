import { RefreshCw, Smartphone } from 'lucide-react';
import type { ReactNode } from 'react';
import type { PassDevicesDto, PassSyncDeviceDto } from '@/shared/contracts/events.ts';
import type { PassDetailDto } from '@/shared/contracts/passes.ts';
import { useInsertHighlight } from '../../../lib/motion.ts';
import {
  CardBody,
  EmptyState,
  ErrorState,
  Handoff,
  IconButton,
  ListRow,
  ListRows,
  SkeletonRows,
  StatusPill,
} from '../../../ui/index.ts';
import { RelTime, useNow } from '../../../ui/rel-time.tsx';
import { usePassDevices } from './sync-api.ts';
import { SIMULATED_DEVICE } from './sync-labels.ts';
import { pushReason, shortDevice } from './sync-model.ts';
import { TabCard } from './tab-card.tsx';

const SYNC_PILL = {
  current: 'device_current',
  waiting: 'device_waiting',
  push_failing: 'push_failing',
  removed: 'device_removed',
  unknown: 'device_unknown',
} as const;

/** During a removal the removal state shows, unless the device cannot be reached at all. */
function pillOf(d: PassSyncDeviceDto, removing: boolean): string {
  if (removing && d.removal && d.status !== 'push_failing') return `removal_${d.removal}`;
  return SYNC_PILL[d.status];
}

function Meta({ d, now, version }: { d: PassSyncDeviceDto; now: number; version: number }) {
  const gone = d.registeredAt === null;
  return (
    <>
      <span className="block">
        {gone && d.unregisteredAt !== null ? (
          <>
            Stopped updates <RelTime at={d.unregisteredAt} now={now} />
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
        ) : d.status === 'current' && d.registeredAt !== null ? (
          `Added with v${version}`
        ) : (
          'Never fetched'
        )}
      </span>
      <span className="block">
        {d.lastPush ? (
          <>
            {d.lastPush.ok ? 'Pushed' : 'Push failed'}
            {d.lastPush.version !== null ? ` v${d.lastPush.version}` : ''}
            {!d.lastPush.ok && d.lastPush.reason ? `: ${pushReason(d.lastPush.reason)}` : ''}{' '}
            <RelTime at={d.lastPush.at} now={now} />
          </>
        ) : (
          'No push yet'
        )}
      </span>
    </>
  );
}

/** The `registrations_cap` trigger refuses a 21st device. */
const DEVICE_CAP = 20;

function summary(data: PassDevicesDto): string | null {
  // During a removal the page's callout carries the one count.
  if (data.removal) return null;
  const live = data.devices.filter((d) => d.registeredAt !== null);
  if (live.length === 0) return `No device has the pass (limit ${DEVICE_CAP})`;
  const current = live.filter((d) => d.status === 'current').length;
  return `${current} of ${live.length} ${live.length === 1 ? 'device' : 'devices'} up to date (limit ${DEVICE_CAP})`;
}

/**
 * One row per device: did it get the current version, and if not, why. `extra` is what admin adds
 * under it (the wallet providers' status); the Workbench's token does not read that.
 */
export function DevicesTab({
  pass,
  active,
  flat,
  extra,
}: {
  pass: PassDetailDto;
  active: boolean;
  /** The Workbench inspector: no card around it. */
  flat?: boolean;
  extra?: ReactNode;
}) {
  const query = usePassDevices(pass.id, active);
  const now = useNow();
  const data = query.data;
  const fresh = useInsertHighlight(data?.devices.map((d) => d.device) ?? []);
  if (query.isError && !data)
    return (
      <div className="grid min-w-0 gap-6">
        <ErrorState inline error={query.error} onRetry={() => void query.refetch()} />
        {extra}
      </div>
    );
  const removing = data?.removal != null;
  const Body = flat ? 'div' : CardBody;
  return (
    <div className="grid min-w-0 gap-6">
      <TabCard
        flat={flat}
        title="Devices"
        bodyless
        actions={
          <>
            {data && summary(data) ? (
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
      >
        <Handoff loading={!data} skeleton={<SkeletonRows rows={2} label="Loading devices" />}>
          {data && data.devices.length === 0 ? (
            <EmptyState inline art="phone" title="No devices yet" />
          ) : (
            <Body>
              <ListRows label="Devices">
                {data?.devices.map((d) => (
                  <ListRow
                    key={d.device}
                    rowId={d.device}
                    isNew={fresh.has(d.device)}
                    leading={<Smartphone aria-hidden />}
                    title={
                      <span className="font-mono text-xs" title={d.device}>
                        {d.simulated ? `${SIMULATED_DEVICE} · ` : null}
                        {shortDevice(d.device)}
                      </span>
                    }
                    meta={<Meta d={d} now={now} version={data?.version ?? pass.version} />}
                    trailing={<StatusPill status={pillOf(d, removing)} />}
                  />
                ))}
              </ListRows>
            </Body>
          )}
        </Handoff>
      </TabCard>
      {extra}
    </div>
  );
}
