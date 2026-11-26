import { rolesCapableOf } from './api-scopes.ts';
import type { SqlValue } from './db.ts';

/** A SQL fragment with its `?` parameters, in text order. */
export interface Fragment {
  sql: string;
  params: SqlValue[];
}

/** Role names are a fixed enum, so a list is written into the text: it costs no bind (a statement has 100). */
function roleList(roles: readonly string[]): string {
  if (roles.some((role) => !/^[a-z_]+$/.test(role))) throw new Error('Unexpected role name.');
  return roles.map((role) => `'${role}'`).join(', ');
}

/**
 * The key's creator is still the admin who made it: an active user, at the `access_revision` the key recorded (a
 * disable and re-enable, or the removal of the admin role, moved it), whose last sign-in held the admin role, and with no open `admin_changed` or `disabled_in_idp` report (the owner's removal of the admin
 * role or disabling of the account was only reported: a dry run or a breaker). The key is suspended while it is open, and works again if the report
 * is resolved as kept; a confirmed removal moves the revision.
 */
export const creatorLiveSql = (k: string): string =>
  `EXISTS(SELECT 1 FROM users c WHERE c.id=${k}.created_by AND c.status='active' AND c.access_revision IS ${k}.creator_access_revision AND json_valid(c.last_roles) AND EXISTS(SELECT 1 FROM json_each(c.last_roles) r WHERE r.value='admin') AND NOT EXISTS(SELECT 1 FROM idp_drift d WHERE d.kind IN('admin_changed','disabled_in_idp') AND d.resolved_at IS NULL AND (d.user_id=c.id OR d.subject IN(SELECT subject FROM auth_identities WHERE user_id=c.id))))`;

/**
 * The key row `k` is in force at `now`: not revoked, not past `expires_at` or `retire_at`, and, for a personal key,
 * its membership is live and its user active (the membership is of the key's org: the insert trigger holds that,
 * and neither row's org moves), a platform key's creator is still the admin who made it (`creatorLiveSql`: it dies with its maker, and with their admin role), and a child's parent is neither revoked nor past its `retire_at` (a child never expires after its parent: the insert trigger holds
 * that, so the parent's expiry needs no test here). A key limited to templates or styles is live only with `limited: true`, which the grant actor row passes: its statements enforce the limits (authority-restrict.ts). Every other statement that asks
 * "may this key act" leaves the limit out and so refuses a limited key.
 * One definition for every statement that asks "may this key act".
 */
export function keyLive(k: string, now: number, limited = false): Fragment {
  // One line, short aliases: the text rides in every key grant (docs: a tenant grant stays under 2 KB).
  return {
    sql: `(${k}.revoked_at IS NULL${limited ? '' : ` AND ${k}.restricted=0`} AND (${k}.expires_at IS NULL AND ${k}.retire_at IS NULL OR COALESCE(MIN(${k}.expires_at,${k}.retire_at),${k}.expires_at,${k}.retire_at)>?) AND (${k}.kind<>'personal' OR EXISTS(SELECT 1 FROM org_memberships p JOIN users u ON u.id=p.user_id WHERE p.id=${k}.membership_id AND p.revoked_at IS NULL AND u.status='active')) AND (${k}.kind<>'platform' OR ${creatorLiveSql(k)}) AND NOT EXISTS(SELECT 1 FROM api_keys q WHERE q.id=${k}.parent_key_id AND (q.revoked_at>0 OR q.retire_at<=?)))`,
    params: [now, now],
  };
}

/**
 * The key holds `scope`: it is in the key's stored `scopes` (a role is a label: its bundle was written into
 * `scopes` at mint, so a scope added to a bundle later never reaches an existing key). A personal key also needs its
 * member's current roles to grant what the scope exercises, so it never outlives a demotion.
 */
export function keyHoldsScope(k: string, scope: string): Fragment {
  // No scope named holds nothing (a principal built without one is refused, not an error).
  if (typeof scope !== 'string') return { sql: '(0)', params: [] };
  return {
    sql: `(EXISTS(SELECT 1 FROM json_each(${k}.scopes) s WHERE s.value=?) AND (${k}.kind<>'personal' OR EXISTS(SELECT 1 FROM org_memberships c, json_each(c.roles) m WHERE c.id=${k}.membership_id AND m.value IN (${roleList(rolesCapableOf(scope))}))))`,
    params: [scope],
  };
}

/** Collects a fragment's parameters into a statement built left to right. */
export function withParams(into: SqlValue[], fragment: Fragment): string {
  into.push(...fragment.params);
  return fragment.sql;
}
