// platform.org.personal: the one grant that creates a personal org. It is held by a live platform-admin
// session and writes only the signing-in admin's own org: the marker, the entitlements row, an accepted
// invitation and the org_admin membership, all for the principal's user id (authority-epochs.md section 1.2).
import { AuthorityError } from './authority-error.ts';

export const PERSONAL_ORG_PURPOSE = 'platform.org.personal';
export const PERSONAL_ORG_TABLES = [
  'orgs',
  'org_entitlements',
  'org_invitations',
  'org_memberships',
] as const;
const ADMIN_ROLES = '["org_admin"]';

/** The part of a `Principal` this purpose reads; a narrow shape keeps the tooling's import graph free of db types. */
interface Holder {
  kind: string;
  userId?: string;
  orgId?: string;
}

const refuse = (message: string) => new AuthorityError('GRANT_SCOPE_OVERRIDE', message);

/** Inserts of a personal-org grant: every row names the grant's org and the principal's own user. */
export function personalOrgInsert(
  { purpose, principal, target }: { purpose: string; principal: Holder; target?: string },
  table: string,
  columns: string[],
  values: readonly unknown[],
  copies: boolean,
): void {
  if (purpose !== PERSONAL_ORG_PURPOSE) return;
  if (
    principal.kind !== 'platform' ||
    principal.userId === undefined ||
    principal.orgId !== undefined ||
    target === undefined
  )
    throw refuse(`${purpose} is held by a platform admin session and names the new org as target.`);
  if (copies) throw refuse(`${purpose} copies no rows.`);
  const at = (c: string) => values[columns.indexOf(c)];
  const t = table.toLowerCase();
  if (!(PERSONAL_ORG_TABLES as readonly string[]).includes(t))
    throw refuse(`${purpose} does not write ${table}.`);
  const orgColumn = t === 'orgs' ? 'id' : 'org_id';
  if (at(orgColumn) !== target) throw refuse(`${t}.${orgColumn} must be the grant's org.`);
  if (t === 'orgs' && at('personal_user_id') !== principal.userId)
    throw refuse('A personal org belongs to the grant principal.');
  if (t === 'org_memberships' && at('user_id') !== principal.userId)
    throw refuse('A personal org gives membership to the grant principal only.');
  if ((t === 'org_memberships' || t === 'org_invitations') && at('roles') !== ADMIN_ROLES)
    throw refuse('A personal org grants org_admin only.');
}

/** Everything but an insert (update, delete, upsert, joined, parts) is outside this purpose. */
export function personalOrgOnlyInserts(purpose: string, what: string): void {
  if (purpose === PERSONAL_ORG_PURPOSE) throw refuse(`${purpose} only inserts, not ${what}.`);
}
