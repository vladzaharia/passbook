import type { z } from 'zod';
import type { IdentitySchema } from '@/shared/contracts/identities.ts';
import { formatDayIn } from '@/shared/format-date.ts';
import { StatusPill } from '@/web/ui/index.ts';
import { daysUntil, formatDay } from '../../../lib/format.ts';

type Identity = z.infer<typeof IdentitySchema>;

export const WARN_DAYS = 30;
export const DANGER_DAYS = 7;

/** Days left, computed from notAfter so a stale `daysRemaining` cannot mislead. */
export function remainingDays(
  identity: { notAfter: number | null; daysRemaining?: number | null },
  now: number,
) {
  return identity.notAfter === null
    ? (identity.daysRemaining ?? null)
    : daysUntil(identity.notAfter, now);
}

export function ExpiryPill({
  identity,
  now,
  zone,
}: {
  identity: Pick<Identity, 'notAfter' | 'daysRemaining'>;
  now: number;
  /** Shows the date on this zone's calendar (platform views: America/Los_Angeles). */
  zone?: string;
}) {
  const days = remainingDays(identity, now);
  if (days === null) return <span className="text-fg-muted">Unknown</span>;
  const status =
    days < 0
      ? 'failing'
      : days <= DANGER_DAYS
        ? 'failing'
        : days <= WARN_DAYS
          ? 'degraded'
          : 'verified';
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
        <span className="text-xs text-fg-muted">
          {zone ? formatDayIn(identity.notAfter, zone) : formatDay(identity.notAfter)}
        </span>
      ) : null}
    </span>
  );
}
