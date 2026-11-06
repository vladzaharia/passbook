import type { Mode } from '../../../shared/contracts/common.ts';
import type { ScanSession } from '../../../shared/contracts/scan-session.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { getOrgRow } from '../orgs/repo.ts';
import { parseSettings } from './dto-console.ts';
import { getScanner } from './repo-device.ts';
import { readScannerScope } from './repo-scope.ts';

/**
 * What `POST /scan/pair` answers with. The posture only: SV.1's `GET /scan/session` is the full
 * session (templates, formats, counts) and the client reads it right after pairing.
 */
export async function pairedSession(
  ctx: ServiceContext,
  scannerId: string,
  csrfToken: string | null,
): Promise<ScanSession> {
  const db = ctx.env.DB;
  const now = ctx.clock.now();
  const row = await getScanner(db, scannerId);
  if (!row) throw new AppError('PAIRING_INVALID', 400, 'Code not valid. Ask for a new one.');
  const [scope, org] = await Promise.all([
    readScannerScope(db, row, null),
    getOrgRow(db, row.orgId),
  ]);
  const settings = parseSettings(row.settings);
  const event = scope.event;
  const state: ScanSession['state'] = settings.staffSignIn
    ? 'staff_required'
    : scope.templateIds.length === 0
      ? 'unassigned'
      : event && now < event.opensAt
        ? 'not_open'
        : event && now > event.closesAt
          ? 'closed'
          : 'ready';
  return {
    principal: 'scanner',
    state,
    scanner: {
      id: row.id,
      name: row.name,
      kind: row.kind,
      deviceRole: row.deviceRole,
      mode: row.mode as Mode,
      orgId: row.orgId,
      orgName: org?.name ?? '',
      timeZone: row.timeZone,
      settings,
    },
    admin: null,
    event: event
      ? {
          id: event.id,
          name: event.name,
          opensAt: event.opensAt,
          closesAt: event.closesAt,
          timeZone: event.timeZone,
          reentry: event.reentry,
          note: event.note,
        }
      : null,
    templates: [],
    formats: [],
    staff: null,
    staffList: null,
    approvals: false,
    csrfToken,
    undoWindowMinutes: 10,
    counts: { today: 0, event: null, asOf: now, configRev: row.updatedAt },
  };
}
