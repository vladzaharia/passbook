import type { z } from 'zod';
import type { IdentitySchema } from '@/shared/contracts/identities.ts';
import { StatusPill } from '@/web/ui/index.ts';
import { daysUntil, formatDay } from '../../lib/format.ts';

type Identity = z.infer<typeof IdentitySchema>;

export const WARN_DAYS = 30;

/** Days left, computed from notAfter so a stale `daysRemaining` cannot mislead. */
export function remainingDays(identity: Pick<Identity, 'notAfter' | 'daysRemaining'>, now: number) {
  return identity.notAfter === null ? identity.daysRemaining : daysUntil(identity.notAfter, now);
}

export function ExpiryPill({ identity, now }: { identity: Identity; now: number }) {
  const days = remainingDays(identity, now);
  if (days === null) return <span className="text-fg-muted">Unknown</span>;
  const status = days < 0 ? 'failing' : days <= WARN_DAYS ? 'degraded' : 'verified';
  const label =
    days < 0
      ? `Expired ${-days} ${-days === 1 ? 'day' : 'days'} ago`
      : days === 0
        ? 'Expires today'
        : `${days} ${days === 1 ? 'day' : 'days'} left`;
  return (
    <span className="flex flex-col items-start gap-0.5">
      <StatusPill status={status}>{label}</StatusPill>
      {identity.notAfter ? (
        <span className="text-xs text-fg-muted">{formatDay(identity.notAfter)}</span>
      ) : null}
    </span>
  );
}

export function ApnsPill({ identity }: { identity: Identity }) {
  if (!identity.apnsAvailable) return <StatusPill status="not_configured">Not set up</StatusPill>;
  if (identity.apnsHealth === 'healthy') return <StatusPill status="verified">Healthy</StatusPill>;
  if (identity.apnsHealth === 'failing') return <StatusPill status="failing">Failing</StatusPill>;
  return <StatusPill status="not_checked" />;
}
