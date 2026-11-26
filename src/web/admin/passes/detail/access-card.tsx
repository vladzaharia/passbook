import { Clock, Infinity as InfinityIcon, Ticket } from 'lucide-react';
import { useMemo } from 'react';
import { hoursText } from '@/passkit/template/access/scope.ts';
import type { PassDetailDto } from '@/shared/contracts/passes.ts';
import { formatDateTime, formatWeekdayTime } from '../../../lib/format.ts';
import { Badge, Card, CardBody, CardHeader, KeyValue } from '../../../ui/index.ts';
import { checkedAtNames } from '../../scanning/zones/checked-at.ts';
import { useZones } from '../../scanning/zones-query.ts';
import { useOrgTimeZone } from '../../settings/use-org-time-zone.ts';
import {
  type AccessState,
  type AccessStatus,
  accessOf,
  accessState,
} from '../inputs/access-state.ts';

const KIND = {
  always: { label: '24/7', icon: InfinityIcon },
  timed: { label: 'Timed', icon: Clock },
  guest: { label: 'Guest', icon: Ticket },
} as const;

function StatusLine({ status, zone }: { status: AccessStatus; zone: string }) {
  switch (status.kind) {
    case 'open':
      return <Badge tone="success">Open now</Badge>;
    case 'opens':
      return <Badge tone="warning">Opens {formatWeekdayTime(status.at, zone)}</Badge>;
    case 'suspended':
      return <Badge tone="danger">Suspended</Badge>;
    case 'not_started':
      return <Badge tone="warning">Starts {formatDateTime(status.at)}</Badge>;
    case 'ended':
      return <Badge tone="danger">Ended {formatDateTime(status.at)}</Badge>;
    default:
      return <Badge>Closed</Badge>;
  }
}

function Body({ state, checkedAt }: { state: AccessState; checkedAt: string[] }) {
  const { plan } = state;
  if (!plan)
    return (
      <p role="alert" className="text-sm text-danger">
        {state.unknown
          ? `This pass holds a plan the template no longer has: ${state.unknown}.`
          : 'This pass has no plan.'}
      </p>
    );
  const Icon = KIND[plan.kind].icon;
  return (
    <KeyValue
      items={[
        {
          label: 'Plan',
          value: (
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-fg-strong">{plan.label}</span>
              <Badge tone={plan.kind === 'guest' ? 'info' : 'accent'}>
                <Icon aria-hidden />
                {KIND[plan.kind].label}
              </Badge>
            </span>
          ),
        },
        ...(plan.kind === 'always'
          ? []
          : [{ label: 'Hours', value: hoursText(plan.hours) || null }]),
        {
          label: 'Zones',
          value:
            state.zones.length > 0 ? (
              <ul aria-label="Zones" className="flex flex-wrap gap-1.5">
                {state.zones.map((z) => (
                  <li key={z.key}>
                    <Badge tone={z.extra ? 'info' : 'neutral'}>
                      {z.name}
                      {z.extra ? <span className="sr-only"> (extra)</span> : null}
                    </Badge>
                  </li>
                ))}
              </ul>
            ) : null,
        },
        {
          label: 'Checked at',
          value: checkedAt.length > 0 ? checkedAt.join(', ') : 'Not checked anywhere',
        },
        { label: 'Now', value: <StatusLine status={state.status} zone={state.timeZone} /> },
      ]}
    />
  );
}

/** A pass's plan, zones and whether the door opens for it now. Shown for access templates only. */
export function AccessCard({ pass, manifest }: { pass: PassDetailDto; manifest: unknown }) {
  const access = accessOf(manifest);
  const zones = useZones();
  const orgZone = useOrgTimeZone(pass.orgId);
  const list = zones.data?.items;
  const state = useMemo(
    () =>
      access
        ? accessState(
            access,
            pass.personalization,
            (list ?? []).map((z) => ({ key: z.key, name: z.name, timeZone: z.effectiveTimeZone })),
            Date.now(),
            orgZone,
          )
        : null,
    [access, pass.personalization, list, orgZone],
  );
  const checkedAt = useMemo(() => {
    const keys = new Set(state?.zones.map((z) => z.key));
    const every = keys.has('*');
    return checkedAtNames((list ?? []).filter((z) => !z.archivedAt && (every || keys.has(z.key))));
  }, [state, list]);
  if (!state) return null;
  return (
    <Card>
      <CardHeader title="Access" />
      <CardBody>
        <Body state={state} checkedAt={checkedAt} />
      </CardBody>
    </Card>
  );
}
