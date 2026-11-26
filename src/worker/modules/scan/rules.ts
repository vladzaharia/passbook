import type { ScannerSettings, ScanRole } from '../../../shared/contracts/scan.ts';

/** door ⊂ desk ⊂ manager. */
export const ROLE_RANK: Record<ScanRole, number> = { door: 0, desk: 1, manager: 2 };

const DAY = 86_400_000;
/** An admin's reach for undoing another scan from /scan (SA 2.4). */
export const ADMIN_UNDO_MS = DAY;

export interface RoleInput {
  principal: 'scanner' | 'admin';
  /** The signed-in staff member's role, if any. */
  staffRole: ScanRole | null;
  settings: Pick<ScannerSettings, 'roleWithoutSignIn' | 'staffSignIn'>;
}

/** SA 2.2. Null only when staff sign-in is required and nobody is signed in. */
export function effectiveRole(input: RoleInput): ScanRole | null {
  if (input.principal === 'admin') return 'manager';
  return input.settings.staffSignIn ? input.staffRole : input.settings.roleWithoutSignIn;
}

/** The slice of a ScanActor the policy reads. */
export interface PolicyActor {
  principal: 'scanner' | 'admin';
  role: ScanRole;
  /** A terminal (bearer) runs its role with no staff and no approvals. */
  terminal: boolean;
  actorKey: string;
  staffId: string | null;
  /** The API key acting as this terminal; its scans and the terminal's own are not each other's. */
  apiKeyId?: string | null;
  settings: Pick<ScannerSettings, 'lookup' | 'letInAgain'> & {
    hardLimit?: boolean | undefined;
    approvals?: 'managers' | 'desk' | undefined;
  };
}

export interface UndoTarget {
  actorKey: string;
  staffId: string | null;
  apiKeyId?: string | null;
  at: number;
  /** Written on this scanner, in the scanner's local day. Always false for admin-made lookups. */
  sameScannerToday: boolean;
}

export type PolicyRequest =
  | { kind: 'lookup' }
  | { kind: 'search' }
  | { kind: 'act'; minRole: ScanRole; amount?: number | null; max?: number | null }
  | { kind: 'check_out' }
  | { kind: 'let_in_again' }
  | { kind: 'cooldown_override' }
  | { kind: 'capacity_override' }
  | { kind: 'access_override' }
  | { kind: 'mark_out' }
  | { kind: 'sign_out' }
  | { kind: 'undo'; scan: UndoTarget; now: number; undoWindowMinutes: number }
  | { kind: 'bundle' }
  | { kind: 'card' }
  | { kind: 'tag_confirm' };

export type PolicyVerdict =
  | { allow: true; view?: 'summary' }
  | { allow: false; why: 'needs_approval' | 'forbidden' };

const ACCESS_REASONS = new Set([
  'zone_not_included',
  'outside_hours',
  'guest_expired',
  'guest_visits_used',
]);

/**
 * Which policy lets an override through. A full place follows `letInAgain` (and a Hard limit closes it
 * for everyone); every access refusal needs a manager: a `not_yet_valid` that was refused (not held) is an access one.
 */
export function overridePolicyKind(
  reason: string | null,
  outcome: string | null = null,
): 'let_in_again' | 'cooldown_override' | 'capacity_override' | 'access_override' {
  if (reason === 'capacity_full') return 'capacity_override';
  if (reason === 'cooldown') return 'cooldown_override';
  if (
    (reason !== null && ACCESS_REASONS.has(reason)) ||
    (reason === 'not_yet_valid' && outcome === 'refused')
  )
    return 'access_override';
  return 'let_in_again';
}

/**
 * Whether a Desk member's PIN approves, where a Manager's would. Only a session that opts in
 * (`approvals: 'desk'`) allows it, and a `set` or an amount over its max always needs a Manager.
 */
export const deskMayApprove = (
  settings: { approvals?: 'managers' | 'desk' | undefined },
  action: { kind: string },
  overMax: boolean,
): boolean => settings.approvals === 'desk' && action.kind !== 'set' && !overMax;

const ALLOW: PolicyVerdict = { allow: true };
const FORBIDDEN: PolicyVerdict = { allow: false, why: 'forbidden' };
const NEEDS: PolicyVerdict = { allow: false, why: 'needs_approval' };

/**
 * The only place rights are decided (SA 2.4 Matrix B). `approved` means a Manager's PIN was just
 * verified for this one action. A terminal can never be approved, and gets `forbidden` where a
 * person would get `needs_approval`.
 */
export function scanPolicy(
  actor: PolicyActor,
  request: PolicyRequest,
  approved = false,
): PolicyVerdict {
  const manager = actor.role === 'manager';
  /** Allowed outright for managers and admins; others need a Manager's PIN. */
  const managerOnly = (): PolicyVerdict => {
    if (manager) return ALLOW;
    if (actor.terminal) return FORBIDDEN;
    return approved ? ALLOW : NEEDS;
  };
  switch (request.kind) {
    case 'lookup':
      return ALLOW;
    case 'search':
      return actor.terminal || !actor.settings.lookup ? FORBIDDEN : ALLOW;
    case 'card':
      return actor.terminal ? { allow: true, view: 'summary' } : ALLOW;
    case 'check_out':
    case 'bundle':
      return actor.terminal ? FORBIDDEN : ALLOW;
    case 'act': {
      const overMax = request.max != null && request.amount != null && request.amount > request.max;
      if (ROLE_RANK[actor.role] >= ROLE_RANK[request.minRole] && !overMax) return ALLOW;
      if (manager) return ALLOW;
      if (actor.terminal) return FORBIDDEN;
      return approved ? ALLOW : NEEDS;
    }
    case 'capacity_override':
    case 'let_in_again':
      // A full place follows who can admit again, unless the door's Hard limit refuses everyone (OC A4).
      if (request.kind === 'capacity_override' && actor.settings.hardLimit === true)
        return FORBIDDEN;
      if (actor.settings.letInAgain === 'never') return FORBIDDEN;
      if (actor.settings.letInAgain === 'anyone') return actor.terminal ? FORBIDDEN : ALLOW;
      return managerOnly();
    case 'cooldown_override':
    case 'access_override':
    case 'tag_confirm':
      return managerOnly();
    case 'mark_out':
      return !actor.terminal && ROLE_RANK[actor.role] >= ROLE_RANK.desk ? ALLOW : FORBIDDEN;
    // A Desk terminal (a till key) may sign a person out; marking out alone stays with people.
    case 'sign_out':
      return ROLE_RANK[actor.role] >= ROLE_RANK.desk ? ALLOW : FORBIDDEN;
    case 'undo': {
      const { scan, now } = request;
      const own =
        scan.actorKey === actor.actorKey &&
        (scan.apiKeyId ?? null) === (actor.apiKeyId ?? null) &&
        (actor.staffId === null || scan.staffId === actor.staffId);
      if (own && now - scan.at <= request.undoWindowMinutes * 60_000) return ALLOW;
      // Past the window an own scan is judged like anyone's.
      if (actor.principal === 'admin') return now - scan.at <= ADMIN_UNDO_MS ? ALLOW : FORBIDDEN;
      if (!scan.sameScannerToday) return FORBIDDEN;
      return managerOnly();
    }
  }
}
