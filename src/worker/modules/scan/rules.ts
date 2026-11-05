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
  if (input.staffRole) return input.staffRole;
  return input.settings.staffSignIn ? null : input.settings.roleWithoutSignIn;
}

/** The slice of a ScanActor the policy reads. */
export interface PolicyActor {
  principal: 'scanner' | 'admin';
  role: ScanRole;
  /** A terminal (bearer) runs its role with no staff and no approvals. */
  terminal: boolean;
  actorKey: string;
  staffId: string | null;
  settings: Pick<ScannerSettings, 'lookup' | 'letInAgain'>;
}

export interface UndoTarget {
  actorKey: string;
  staffId: string | null;
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
  | { kind: 'undo'; scan: UndoTarget; now: number; undoWindowMinutes: number }
  | { kind: 'bundle' }
  | { kind: 'card' };

export type PolicyVerdict =
  | { allow: true; view?: 'summary' }
  | { allow: false; why: 'needs_approval' | 'forbidden' };

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
    case 'let_in_again':
      if (actor.settings.letInAgain === 'never') return FORBIDDEN;
      if (actor.settings.letInAgain === 'anyone') return actor.terminal ? FORBIDDEN : ALLOW;
      return managerOnly();
    case 'cooldown_override':
      return managerOnly();
    case 'undo': {
      const { scan, now } = request;
      const own =
        scan.actorKey === actor.actorKey &&
        (actor.staffId === null || scan.staffId === actor.staffId);
      if (own) return now - scan.at <= request.undoWindowMinutes * 60_000 ? ALLOW : FORBIDDEN;
      if (actor.principal === 'admin') return now - scan.at <= ADMIN_UNDO_MS ? ALLOW : FORBIDDEN;
      if (!scan.sameScannerToday) return FORBIDDEN;
      return managerOnly();
    }
  }
}
