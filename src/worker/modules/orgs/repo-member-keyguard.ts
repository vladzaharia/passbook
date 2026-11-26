import type { Check } from '../../platform/authority-checks.ts';
import type { Principal } from '../../platform/authority-principal.ts';
import { ADMINISTERING_ROLES } from '../../platform/org-role-grants.ts';

/** A refused key write is the row changing under it: 409 `MEMBERSHIP_CONFLICT`. */
export const KEY_GUARD_CODES = { stale: 'MEMBERSHIP_CONFLICT' } as const;

const administering = JSON.stringify(ADMINISTERING_ROLES);

/**
 * A key's grants never write over a role that administers the org (the service refuses first; this is the same
 * rule at commit, so a member promoted between the read and the write is left alone). `roles` are the ones being
 * written, `row` the stored roles of the invitation or membership the write retires. Sessions are not limited.
 * Stored roles that do not parse count as administering.
 */
export function keyNotAdministering(
  principal: Principal,
  what: { roles: string } | { table: 'org_invitations' | 'org_memberships'; id: string },
): Check[] {
  if (principal.kind !== 'api_key') return [];
  return [
    {
      reason: 'stale',
      ok: (b) => {
        if ('roles' in what) {
          const sql = `CASE WHEN json_valid(?) THEN NOT EXISTS (SELECT 1 FROM json_each(?) r
            WHERE r.type != 'text' OR r.value IN (SELECT value FROM json_each(?))) ELSE 0 END`;
          for (const v of [what.roles, what.roles, administering]) b.bind(v);
          return sql;
        }
        const sql = `NOT EXISTS (SELECT 1 FROM ${what.table} t WHERE t.id = ? AND t.org_id = a.org_id
          AND CASE WHEN json_valid(t.roles) THEN EXISTS (SELECT 1 FROM json_each(t.roles) r
            WHERE r.type != 'text' OR r.value IN (SELECT value FROM json_each(?))) ELSE 1 END)`;
        for (const v of [what.id, administering]) b.bind(v);
        return sql;
      },
    },
  ];
}
