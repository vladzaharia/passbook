import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { all, run } from '../../platform/db.ts';
import { makeDoor } from './access-test-fixtures.ts';
import { kit, out } from './act-test-fixtures.ts';
import { key } from './test-kit.ts';

/** Bind a signed-in staff member to a device, as a PIN sign-in just did. */
export async function signIn(scannerId: string, staffId: string): Promise<void> {
  const now = kit.clock.now();
  await run(
    kit.env.DB,
    'UPDATE scanners SET staff_id = ?, staff_since = ?, staff_seen_at = ? WHERE id = ?',
    [staffId, now, now, scannerId],
  );
}

/**
 * A door and a monitor in one session, a staff member signed in on both (a monitor acts for a person).
 * `unattended` leaves the monitor with nobody signed in; `role` is the signed-in person's role.
 */
export async function doorAndMonitor(
  tpl: string,
  zoneIds: string[],
  o: {
    deskActions?: boolean;
    role?: 'door' | 'desk';
    letInAgain?: 'anyone' | 'manager' | 'never';
    hardLimit?: boolean;
    unattended?: boolean;
    deviceRole?: 'monitor' | 'customer';
  } = {},
) {
  const door = await makeDoor([tpl], zoneIds);
  await run(
    kit.env.DB,
    'UPDATE scanning_sessions SET settings = json_set(settings, ?, json(?), ?, ?, ?, json(?), ?, json(?)) WHERE id = ?',
    [
      '$.deskActions',
      o.deskActions === false ? 'false' : 'true',
      '$.letInAgain',
      o.letInAgain ?? 'anyone',
      '$.staffSignIn',
      'true',
      '$.hardLimit',
      o.hardLimit ? 'true' : 'false',
      door.sessionId,
    ],
  );
  const staff = await kit.staff(o.role ?? 'desk');
  const monitor = await kit.scanner({ templateIds: [tpl], deviceRole: o.deviceRole ?? 'monitor' });
  await run(
    kit.env.DB,
    `INSERT INTO scanning_devices (scanner_id,session_id,org_id,mode,surface,effective_surface,overrides)
     SELECT id,?,org_id,mode,'desk','desk','{}' FROM scanners WHERE id=?`,
    [door.sessionId, monitor.id],
  );
  const bind = async () => {
    await signIn(door.scanner.id, staff.id);
    if (!o.unattended) await signIn(monitor.id, staff.id);
  };
  await bind();
  return { door, monitor, staff, sessionId: door.sessionId, bind };
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
