import type {
  Developer,
  DeveloperInvitation,
} from '../../../shared/contracts/developer-invitations.ts';
import type { OrgRole } from '../../../shared/contracts/org-membership.ts';
import { parseRoles } from '../orgs/access.ts';
import type { DeveloperListRow, InvitationListRow } from './repo-read.ts';

/** Roles are stored as JSON by the org invitation or membership; a row that does not parse reads as none. */
function rolesOf(json: string | null): OrgRole[] {
  if (json === null) return [];
  try {
    return parseRoles(json);
  } catch {
    return [];
  }
}

export function invitationDto(row: InvitationListRow, now: number): DeveloperInvitation {
  return {
    id: row.id,
    orgId: row.org_id,
    email: row.email,
    roles: rolesOf(row.roles),
    state: row.revoked_at !== null ? 'revoked' : row.expires_at > now ? 'pending' : 'expired',
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

export const developerDto = (row: DeveloperListRow): Developer => ({
  userId: row.user_id,
  name: row.name,
  email: row.email,
  since: row.since,
  roles: row.roles === null ? null : rolesOf(row.roles),
});
