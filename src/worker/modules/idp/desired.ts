import { activePlatformGrants } from './repo-role-grants.ts';
import {
  type ClaimSource,
  claimSources,
  identityOfSubject,
  liveGroupKeys,
  memberSources,
  membershipSources,
  ruleSources,
  ruleSourcesForRoles,
  sponsorOrgs,
} from './repo-sources.ts';
import type { GroupTarget, Target } from './types.ts';

/** Why a target is wanted: one entry per live source. The Access card lists them, the drain ignores them. */
export type Reason =
  | { kind: 'membership'; orgId: string }
  | { kind: 'sponsorship'; orgId: string }
  | { kind: 'platform_grant' }
  | { kind: 'org_rule'; ruleId: string; orgId: string }
  | { kind: 'group_member'; memberId: string; source: 'manual' | 'invitation' }
  | { kind: 'claim'; claimId: string; invitation: ClaimSource['invitation'] };

export interface Desired {
  subject: string;
  /** Null when no PassBook user has this subject (a person invited to groups only). */
  userId: string | null;
  /**
   * `platform_admin`: skipped, the binding refuses them and they hold everything implied. `disabled`: wants
   * nothing, so the drain removes what PassBook added. Both carry no targets.
   */
  skip: 'platform_admin' | 'disabled' | null;
  targets: Map<Target, Reason[]>;
}

const asGroup = (key: string): GroupTarget => `g:${key}`;

/** Whether the roles of a user's last sign-in name admin. Roles that do not parse count as admin: a refusal, never a pass. */
export const isPlatformAdmin = (lastRoles: string): boolean => {
  try {
    const roles: unknown = JSON.parse(lastRoles);
    return !Array.isArray(roles) || roles.includes('admin');
  } catch {
    return true;
  }
};

function add(targets: Map<Target, Reason[]>, target: Target, reason: Reason): void {
  const list = targets.get(target);
  if (list) list.push(reason);
  else targets.set(target, [reason]);
}

/**
 * What a Polaris ID subject should hold, from D1 alone (design 1 section 3.2, design 2 section 2.2):
 * - console: a live membership in an active or suspended org (never a personal org; developer sandboxes count),
 *   or an open claim on a member invitation, or on a developer invitation paired with an open member one;
 * - developer: a live sponsorship, a live platform grant, or an open claim on a developer or platform invitation
 *   that asks for it;
 * - support: a live platform grant;
 * - `g:<key>`: a live org rule the user meets (standard orgs only), a live manual or invitation membership, or an
 *   open claim that names the group (a platform invitation's groups, or the org rules of the invited roles).
 * A disabled user and a platform admin want nothing. Open setups add no reason: their subject is unknown until
 * the proof, and the signup token already carried the group. Holds and external presence are applied by the drain.
 * A subject with no PassBook user still gets its group memberships and claims.
 */
export async function desiredState(db: D1Database, subject: string, now: number): Promise<Desired> {
  const identity = await identityOfSubject(db, subject);
  const targets = new Map<Target, Reason[]>();
  const out = (skip: Desired['skip']): Desired => ({
    subject,
    userId: identity?.user_id ?? null,
    skip,
    targets: skip ? new Map() : targets,
  });
  if (identity?.status === 'disabled') return out('disabled');
  if (identity && isPlatformAdmin(identity.last_roles)) return out('platform_admin');

  if (identity) {
    for (const m of await membershipSources(db, identity.user_id))
      add(targets, 'console', { kind: 'membership', orgId: m.org_id });
    for (const orgId of await sponsorOrgs(db, identity.user_id))
      add(targets, 'developer', { kind: 'sponsorship', orgId });
    for (const g of await activePlatformGrants(db, identity.user_id))
      add(targets, g.role, { kind: 'platform_grant' });
    for (const r of await ruleSources(db, identity.user_id))
      add(targets, asGroup(r.group_key), { kind: 'org_rule', ruleId: r.rule_id, orgId: r.org_id });
  }
  for (const m of await memberSources(db, subject))
    add(targets, asGroup(m.group_key), { kind: 'group_member', memberId: m.id, source: m.source });

  for (const c of await claimSources(db, subject, now)) {
    const reason: Reason = { kind: 'claim', claimId: c.id, invitation: c.invitation };
    if (c.invitation === 'member') add(targets, 'console', reason);
    if (c.invitation === 'developer') add(targets, 'developer', reason);
    if (c.invitation === 'platform' && c.developer === 1) add(targets, 'developer', reason);
    // A paired developer invitation also carries its member invitation: console and the rules of its roles.
    if (c.invitation === 'developer' && c.org_id) add(targets, 'console', reason);
    if (c.org_id && c.org_roles)
      for (const r of await ruleSourcesForRoles(db, c.org_id, c.org_roles))
        add(targets, asGroup(r.group_key), reason);
    if (c.groups) {
      const keys: string[] = JSON.parse(c.groups);
      for (const key of await liveGroupKeys(db, keys)) add(targets, asGroup(key), reason);
    }
  }
  return out(null);
}

/** The wanted targets, sorted. */
export const targetKeys = (d: Desired): Target[] => [...d.targets.keys()].sort();
