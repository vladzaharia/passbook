import type { Mode } from '../../../shared/contracts/common.ts';
import {
  type ScannerSettings,
  ScannerSettingsSchema,
  type ScanRole,
} from '../../../shared/contracts/scan.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { ScannerRow } from './repo-device.ts';
import type { ScanEventRow } from './repo-scope.ts';
import { effectiveRole } from './rules.ts';
import type { ResolvedScope } from './scope.ts';
import type { BoundStaff } from './staff-binding.ts';

export interface ScanActor {
  principal: 'scanner' | 'admin';
  orgId: string;
  mode: Mode;
  /** `s:<scannerId>` or `u:<userId>`: the idempotency namespace and "own". */
  actorKey: string;
  actor: { type: 'scanner' | 'user'; id: string };
  scanner: ScannerRow | null;
  event: ScanEventRow | null;
  templateIds: string[];
  timeZone: string;
  /** Null only on routes exempt from staff sign-in, while it is required and missing. */
  role: ScanRole | null;
  staff: BoundStaff | null;
  settings: ScannerSettings;
  /** "Front door", or "Admin console". */
  name: string;
  /** A bearer terminal: its role, no staff, no approvals. */
  terminal: boolean;
}

/** An admin scans with everything on. */
export const ADMIN_SETTINGS: ScannerSettings = {
  flow: 'choose',
  defaultActionId: null,
  roleWithoutSignIn: 'desk',
  staffSignIn: false,
  letInAgain: 'anyone',
  reader: 'none',
  lookup: true,
  offline: false,
  dailyAmount: null,
};

/** Used when a stored settings blob does not parse: the strictest posture. */
const LOCKED_SETTINGS: ScannerSettings = {
  ...ADMIN_SETTINGS,
  flow: 'auto',
  roleWithoutSignIn: 'door',
  letInAgain: 'manager',
  lookup: false,
};

function settingsOf(ctx: ServiceContext, row: ScannerRow): ScannerSettings {
  try {
    const parsed = ScannerSettingsSchema.safeParse(JSON.parse(row.settings));
    if (parsed.success) return parsed.data;
  } catch {
    // falls through to the log below
  }
  ctx.log.error('scan.settings_invalid', { code: 'SCAN_SETTINGS_INVALID', scannerId: row.id });
  return LOCKED_SETTINGS;
}

export function scannerActor(
  ctx: ServiceContext,
  row: ScannerRow,
  mode: Mode,
  transport: 'cookie' | 'bearer',
  scope: { event: ScanEventRow | null; templateIds: string[] },
): ScanActor {
  return {
    principal: 'scanner',
    orgId: row.orgId,
    mode,
    actorKey: `s:${row.id}`,
    actor: { type: 'scanner', id: row.id },
    scanner: row,
    event: scope.event,
    templateIds: scope.templateIds,
    timeZone: scope.event?.timeZone ?? row.timeZone,
    role: null,
    staff: null,
    settings: settingsOf(ctx, row),
    name: row.name,
    terminal: transport === 'bearer',
  };
}

export function adminActor(session: SessionAuth, mode: Mode, scope: ResolvedScope): ScanActor {
  return {
    principal: 'admin',
    orgId: scope.orgId,
    mode,
    actorKey: `u:${session.userId}`,
    actor: { type: 'user', id: session.userId },
    scanner: null,
    event: scope.event,
    templateIds: scope.templateIds,
    timeZone: scope.timeZone,
    role: 'manager',
    staff: null,
    settings: ADMIN_SETTINGS,
    name: 'Admin console',
    terminal: false,
  };
}

/** Sets the role once staff is known. A terminal runs its own role; nobody signs in on it. */
export function withRole(actor: ScanActor, staff: BoundStaff | null): ScanActor {
  actor.staff = staff;
  actor.role = actor.terminal
    ? actor.settings.roleWithoutSignIn
    : effectiveRole({
        principal: 'scanner',
        staffRole: staff?.role ?? null,
        settings: actor.settings,
      });
  return actor;
}
