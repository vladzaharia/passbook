import type { z } from 'zod';
import type { UpdateScanningSessionSchema } from '../../../shared/contracts/scanning-sessions.ts';
import type { Grant } from '../../platform/authority.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { audited } from './repo-admin-grant.ts';
import type { ScanningSessionRow } from './repo-scanning-sessions.ts';
import { nextEdgeAt } from './session-hours.ts';

type Edit = Pick<z.infer<typeof UpdateScanningSessionSchema>, 'hours' | 'status' | 'timeZone'>;

/**
 * The timing columns an update writes. Resume clears the hold; the bookmark follows whatever the
 * edit leaves (status, hours, zone, hold), and only an active session has one.
 */
export function timingPatch(row: ScanningSessionRow, input: Edit, now: number) {
  const hours =
    input.hours === undefined
      ? row.hours
      : input.hours === null
        ? null
        : JSON.stringify(input.hours);
  const hold = input.status === 'active' ? null : row.hold;
  const status = input.status ?? row.status;
  const time_zone = input.timeZone ?? row.time_zone;
  return {
    hours,
    hold,
    hours_next_at: status === 'active' ? nextEdgeAt({ time_zone, hours, hold }, now) : null,
  };
}

/** A new session starts active with no hold. */
export function newTiming(
  timeZone: string,
  schedule: (Edit['hours'] & object) | null,
  now: number,
) {
  const hours = schedule === null ? null : JSON.stringify(schedule);
  return { hours, hours_next_at: nextEdgeAt({ time_zone: timeZone, hours }, now) };
}

/** The audit row of a schedule edit (the update's own row records the rest). */
export function addHoursAudit(
  g: Grant,
  ctx: ServiceContext,
  row: ScanningSessionRow,
  userId: string,
  hours: Edit['hours'],
): void {
  if (hours === undefined) return;
  g.add(
    audited(g, ctx, {
      orgId: row.org_id,
      actorType: 'user',
      actorId: userId,
      action: 'scanning.session_hours',
      targetType: 'scanning_session',
      targetId: row.id,
      detail: { set: hours !== null },
    }),
  );
}
