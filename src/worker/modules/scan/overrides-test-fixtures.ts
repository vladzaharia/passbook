import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { all, run } from '../../platform/db.ts';
import { makeDoor } from './access-test-fixtures.ts';
import { kit, out } from './act-test-fixtures.ts';
import { key } from './test-kit.ts';

/** A door and a monitor in one session: the monitor acts for what the door answers. */
export async function doorAndMonitor(
  tpl: string,
  zoneIds: string[],
  o: {
    deskActions?: boolean;
    role?: 'door' | 'desk';
    letInAgain?: 'anyone' | 'manager' | 'never';
    staffSignIn?: boolean;
    deviceRole?: 'monitor' | 'customer';
  } = {},
) {
  const door = await makeDoor([tpl], zoneIds);
  await run(
    kit.env.DB,
    'UPDATE scanning_sessions SET settings = json_set(settings, ?, json(?), ?, ?, ?, ?, ?, json(?)) WHERE id = ?',
    [
      '$.deskActions',
      o.deskActions === false ? 'false' : 'true',
      '$.roleWithoutSignIn',
      o.role ?? 'desk',
      '$.letInAgain',
      o.letInAgain ?? 'anyone',
      '$.staffSignIn',
      o.staffSignIn ? 'true' : 'false',
      door.sessionId,
    ],
  );
  const monitor = await kit.scanner({ templateIds: [tpl], deviceRole: o.deviceRole ?? 'monitor' });
  await run(
    kit.env.DB,
    `INSERT INTO scanning_devices (scanner_id,session_id,org_id,mode,surface,effective_surface,overrides)
     SELECT id,?,org_id,mode,'desk','desk','{}' FROM scanners WHERE id=?`,
    [door.sessionId, monitor.id],
  );
  return { door, monitor, sessionId: door.sessionId };
}

export const overrideAs = (
  headers: Record<string, string>,
  overrideOf: string | null,
  extra: Record<string, unknown> = {},
) => kit.post(headers, '/overrides', { idempotencyKey: key(), overrideOf, ...extra });

export const bodyOf = async (res: Response) =>
  (await res.json()) as ScanOutcome & Record<string, unknown>;

export const scanById = async (id: string) =>
  (
    await all<{
      override_of: string | null;
      override_note: string | null;
      outcome: string | null;
      actor_key: string;
      staff_id: string | null;
    }>(
      kit.env.DB,
      'SELECT override_of, override_note, outcome, actor_key, staff_id FROM scans WHERE id = ?',
      [id],
    )
  )[0];

export { out };
