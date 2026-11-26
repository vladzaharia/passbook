import type { OrgRole } from '../../../../shared/contracts/org-membership.ts';
import { inviteKindOf } from '../../../../shared/invitation-link.ts';
import { sha256Hex } from '../../../platform/ids.ts';
import type { ServiceContext } from '../../../platform/service-context.ts';
import { parseRoles } from '../../orgs/access.ts';
import {
  developerInvitationByHash,
  type InviteRow,
  memberInvitationByHash,
} from './repo-resolve.ts';

export type InviteState = 'pending' | 'accepted' | 'revoked' | 'expired';

export interface Invite {
  row: InviteRow;
  kind: InviteRow['kind'];
  state: InviteState;
  /** Past `expires_at` but inside the claim window of a setup or claim: it may be accepted, not started again. */
  late: boolean;
  /** The org roles the person joins with; empty for developer access alone. */
  roles: OrgRole[];
  developer: boolean;
}

/**
 * The invitation a secret names, or null for anything that is not one. The secret's kind prefix picks the table, so a
 * lookup reads one. An unprefixed secret is a member invitation sent before the prefixes. Platform invitations
 * (`p_`) are not served yet.
 */
export async function resolveInvite(ctx: ServiceContext, secret: string): Promise<Invite | null> {
  const kind = inviteKindOf(secret);
  if (kind === null || kind === 'platform') return null;
  const hash = await sha256Hex(secret);
  const row =
    kind === 'developer'
      ? await developerInvitationByHash(ctx.env.DB, hash)
      : await memberInvitationByHash(ctx.env.DB, hash);
  if (!row) return null;
  const now = ctx.clock.now();
  const until = row.claim_until ?? row.expires_at;
  const state: InviteState =
    row.accepted_at !== null || (row.kind === 'developer' && row.member_accepted_at !== null)
      ? 'accepted'
      : row.revoked_at !== null || row.member_revoked_at !== null
        ? 'revoked'
        : !row.org_ok || now >= until
          ? 'expired'
          : 'pending';
  let roles: OrgRole[] = [];
  if (row.member_roles !== null) {
    try {
      roles = parseRoles(row.member_roles);
    } catch {
      return null;
    }
  }
  return {
    row,
    kind: row.kind,
    state,
    late: state === 'pending' && now >= row.expires_at,
    roles,
    developer: row.kind === 'developer',
  };
}

/** `a•••@agency.com`: the first letter and the domain. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '•••';
  return `${email.slice(0, 1)}•••${email.slice(at)}`;
}
