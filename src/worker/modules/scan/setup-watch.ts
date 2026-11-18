import type { z } from 'zod';
import type { Mode } from '../../../shared/contracts/common.ts';
import type { ScanWatchSchema } from '../../../shared/contracts/scan-setups.ts';
import type { DeviceRoleSchema } from '../../../shared/contracts/scanners.ts';
import { NotFoundError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { watchedEvent, watchedScanners, watchedSessions, watchedZones } from './repo-setups.ts';

type Watch = z.input<typeof ScanWatchSchema> | null | undefined;

const unavailable = (what: string) =>
  new NotFoundError(`A watched ${what} is unavailable.`, 'SCANNER_WATCH_NOT_FOUND');

/**
 * A monitor or customer screen follows scanners, sessions, one event or zones, never a mix of
 * another org's or mode's. Customer screens follow scanners or sessions only: a place's crowd
 * is not for a customer. Every id is read under the setup's own org and mode before anything
 * is written; a foreign id is a 404 and looks the same as a missing one.
 */
export async function checkWatch(
  ctx: ServiceContext,
  orgId: string,
  mode: Mode,
  role: z.infer<typeof DeviceRoleSchema>,
  watch: Watch,
  id?: string,
) {
  if (role === 'scan') return;
  const scannerIds = [...new Set(watch?.scannerIds ?? [])];
  const sessionIds = [...new Set(watch?.sessionIds ?? [])];
  const zoneIds = [...new Set(watch?.zoneIds ?? [])];
  const eventId = watch?.eventId;
  const none =
    !watch?.allOrg && !scannerIds.length && !sessionIds.length && !zoneIds.length && !eventId;
  const customerOnly = role === 'customer' && (watch?.allOrg || eventId || zoneIds.length);
  if (!watch || none || customerOnly || scannerIds.includes(id ?? ''))
    throw new ValidationError(
      role === 'customer'
        ? 'Choose the scanners or sessions this screen should follow.'
        : 'Choose what this screen should watch.',
      [],
      'SCANNER_WATCH_INVALID',
    );
  const db = ctx.env.DB;
  if ((await watchedScanners(db, orgId, mode, scannerIds)).length !== scannerIds.length)
    throw unavailable('scanner');
  if ((await watchedSessions(db, orgId, mode, sessionIds)).length !== sessionIds.length)
    throw unavailable('session');
  if (eventId && !(await watchedEvent(db, orgId, mode, eventId))) throw unavailable('event');
  if ((await watchedZones(db, orgId, zoneIds)).length !== zoneIds.length) throw unavailable('zone');
}
