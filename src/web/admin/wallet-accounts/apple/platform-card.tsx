import { Link } from '@tanstack/react-router';
import { ArrowRightLeft, BadgeCheck, ExternalLink } from 'lucide-react';
import type { CSSProperties } from 'react';
import { formatDayIn } from '@/shared/format-date.ts';
import { DEFAULT_TIME_ZONE } from '@/shared/time-zone.ts';
import { cn } from '@/web/lib/cn.ts';
import { formatCount } from '@/web/lib/format.ts';
import { Badge, Button, Card, CardBody, CardHeader, StatusPill } from '@/web/ui/index.ts';
import { PUSH_METHOD_LABEL } from './apns-check.tsx';
import { ExpiryPill } from './expiry.tsx';
import { IdentityStatusPill } from './identity-status.tsx';
import type { PlatformIdentity } from './platform-queries.ts';
import { canMakeDefault } from './platform-ready.ts';

const NAME = { root: 'Root', devtest: 'Device test' } as const;
export const platformName = (row: PlatformIdentity) => (row.slot ? NAME[row.slot] : 'Legacy');

const PUSH_HEALTH = { healthy: 'verified', failing: 'failing', unknown: 'not_checked' } as const;

const day = (ms: number | null) => (ms === null ? '—' : formatDayIn(ms, DEFAULT_TIME_ZONE));

/** One platform identity: state, certificate expiry, push, and how many passes and devices it serves. */
export function PlatformCard({
  row,
  index,
  now,
  onMakeDefault,
  onMove,
}: {
  row: PlatformIdentity;
  index: number;
  now: number;
  onMakeDefault: (row: PlatformIdentity) => void;
  onMove: (row: PlatformIdentity) => void;
}) {
  const legacy = row.slot === null;
  const canMove = row.passCount > 0 && !row.isDefault;
  const facts = [
    {
      label: legacy ? 'Retires' : 'Expires',
      wide: true,
      value: <ExpiryPill identity={row} now={now} zone={DEFAULT_TIME_ZONE} />,
    },
    ...(row.nextRotationAt === null
      ? []
      : [{ label: 'Next rotation', wide: false, value: day(row.nextRotationAt) }]),
    ...(row.pushMethod === 'none'
      ? []
      : [
          {
            label: 'Push',
            wide: false,
            value: (
              <span className="flex flex-wrap items-center gap-2">
                {PUSH_METHOD_LABEL[row.pushMethod]}
                <StatusPill status={PUSH_HEALTH[row.apnsHealth]} />
              </span>
            ),
          },
        ]),
    { label: 'Passes', wide: false, value: formatCount(row.passCount) },
    { label: 'Registrations', wide: false, value: formatCount(row.registrationCount) },
  ];
  return (
    <Card
      data-platform-card={row.slot ?? 'legacy'}
      style={{ '--i': index } as CSSProperties}
      className={cn('flex flex-col', row.dormant && 'opacity-80')}
    >
      <CardHeader
        title={platformName(row)}
        actions={
          <Button asChild size="sm" variant="ghost">
            <Link
              to="/admin/platform/wallet-accounts/$identityId"
              params={{ identityId: row.id }}
              aria-label={`Open ${platformName(row)}`}
            >
              <ExternalLink aria-hidden />
            </Link>
          </Button>
        }
      />
      <CardBody className="flex flex-1 flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={row.managed === 'connector' ? 'accent' : 'neutral'}>
            {row.managed === 'connector' ? 'Managed' : 'Deployment'}
          </Badge>
          {row.isDefault ? <StatusPill status="default" /> : null}
          {row.issuing ? null : <Badge>Not issuing</Badge>}
          {row.dormant ? <Badge>Dormant</Badge> : null}
          <IdentityStatusPill status={row.status} />
        </div>
        <p className="break-all font-mono text-xs text-fg-muted">{row.passTypeIdentifier}</p>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
          {facts.map((f) => (
            <div
              key={f.label}
              className={cn('flex min-w-0 flex-col gap-0.5', f.wide && 'col-span-2')}
            >
              <dt className="text-fg-muted">{f.label}</dt>
              <dd className="min-w-0 break-words text-fg">{f.value}</dd>
            </div>
          ))}
        </dl>
        {canMakeDefault(row) || canMove ? (
          <div className="mt-auto flex flex-wrap gap-2">
            {canMakeDefault(row) ? (
              <Button
                size="sm"
                variant="outline"
                iconStart={<BadgeCheck aria-hidden />}
                onClick={() => onMakeDefault(row)}
              >
                Make default
              </Button>
            ) : null}
            {canMove ? (
              <Button
                size="sm"
                variant="outline"
                iconStart={<ArrowRightLeft aria-hidden />}
                onClick={() => onMove(row)}
              >
                Move passes
              </Button>
            ) : null}
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}
