// platform.org.personal: the one grant that creates a personal org. It is held by a live platform-admin
// session and writes only the signing-in admin's own org: the marker, the entitlements row, an accepted
// invitation and the org_admin membership, all for the principal's user id (authority-epochs.md section 1.2).
// Children are accepted only after the same grant inserted the `orgs` row (which fails on an existing id).
import { AuthorityError } from './authority-error.ts';

export const PERSONAL_ORG_PURPOSE = 'platform.org.personal';
/**
 * `platform.org.create_admin`: a platform admin creates an org and joins it as `org_admin` in one batch.
 * The rules are the personal org's, except the org is not marked personal and takes any preset but developer.
 */
export const CREATOR_ORG_PURPOSE = 'platform.org.create_admin';
export const PERSONAL_ORG_TABLES = [
  'orgs',
  'org_entitlements',
  'org_invitations',
  'org_memberships',
] as const;
/** Unlimited: the plan id `legacy`. A personal org never changes plan. */
const PERSONAL_PRESET = 'legacy';
const ADMIN_ROLES = '["org_admin"]';

/** The part of a `Principal` this purpose reads; a narrow shape keeps the tooling's import graph free of db types. */
interface Holder {
  kind: string;
  userId?: string;
  orgId?: string;
}

/** What the grant has inserted so far: children must follow their org and invitation. */
export interface PersonalState {
  org: boolean;
  invitations: Set<string>;
}
const states = new WeakMap<object, PersonalState>();

const refuse = (message: string) => new AuthorityError('GRANT_SCOPE_OVERRIDE', message);

/** Inserts of a personal-org grant: every row names the grant's org and the principal's own user. */
export function personalOrgInsert(
  input: { purpose: string; principal: Holder; target?: string },
  table: string,
  columns: string[],
  values: readonly unknown[],
  copies: boolean,
): void {
  const { purpose, principal, target } = input;
  const personal = purpose === PERSONAL_ORG_PURPOSE;
  if (!personal && purpose !== CREATOR_ORG_PURPOSE) return;
  if (
    principal.kind !== 'platform' ||
    principal.userId === undefined ||
    principal.orgId !== undefined ||
    target === undefined
  )
    throw refuse(`${purpose} is held by a platform admin session and names the new org as target.`);
  if (copies) throw refuse(`${purpose} copies no rows.`);
  const state = states.get(input) ?? { org: false, invitations: new Set<string>() };
  states.set(input, state);
  const at = (c: string) => values[columns.indexOf(c)];
  const t = table.toLowerCase();
  if (!(PERSONAL_ORG_TABLES as readonly string[]).includes(t))
    throw refuse(`${purpose} does not write ${table}.`);
  const orgColumn = t === 'orgs' ? 'id' : 'org_id';
  if (at(orgColumn) !== target) throw refuse(`${t}.${orgColumn} must be the grant's org.`);
  if (t !== 'orgs' && !state.org) throw refuse(`${t} follows the orgs row of the same grant.`);
  if (t === 'orgs') {
    if (personal ? at('personal_user_id') !== principal.userId : at('personal_user_id') != null)
      throw refuse(
        personal ? 'A personal org belongs to the grant principal.' : 'This org is not personal.',
      );
    if ((at('status') ?? 'active') !== 'active' || (at('kind') ?? 'standard') !== 'standard')
      throw refuse('A personal org is an active standard org.');
  }
  if (
    t === 'org_entitlements' &&
    (personal ? at('preset') !== PERSONAL_PRESET : at('preset') === 'developer')
  )
    throw refuse(
      personal ? 'A personal org has the unlimited preset.' : 'A sandbox is not made here.',
    );
  if (t === 'org_invitations') {
    if (typeof at('accepted_at') !== 'number')
      throw refuse('The invitation of a personal org is already accepted.');
  }
  if (t === 'org_memberships') {
    if (at('user_id') !== principal.userId)
      throw refuse('A personal org gives membership to the grant principal only.');
    if (!state.invitations.has(String(at('invitation_id'))))
      throw refuse('The membership follows the invitation of the same grant.');
  }
  if ((t === 'org_memberships' || t === 'org_invitations') && at('roles') !== ADMIN_ROLES)
    throw refuse('A personal org grants org_admin only.');
  // Recorded last, so a refused row leaves nothing behind.
  if (t === 'orgs') state.org = true;
  if (t === 'org_invitations') state.invitations.add(String(at('id')));
}

/** Everything but an insert (update, delete, upsert, joined, parts) is outside this purpose. */
export function personalOrgOnlyInserts(purpose: string, what: string): void {
  if (purpose === PERSONAL_ORG_PURPOSE || purpose === CREATOR_ORG_PURPOSE)
    throw refuse(`${purpose} only inserts, not ${what}.`);
}
