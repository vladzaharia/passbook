import { rolesCapableOf, rolesWithScope } from './api-scopes.ts';
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
 * The key row `k` is in force at `now`: not revoked, not past `expires_at` or `retire_at`, not a key whose
 * template restrictions no grant enforces yet, and, for a personal key, its membership is live and its
 * user active (the membership is of the key's org: the insert trigger holds that, and neither row's org moves).
 * One definition for every statement that asks "may this key act".
 */
export function keyLive(k: string, now: number): Fragment {
  // One line, short aliases: the text rides in every key grant (docs: a tenant grant stays under 2 KB).
  return {
    sql: `(${k}.revoked_at IS NULL AND ${k}.restricted=0 AND (${k}.expires_at IS NULL AND ${k}.retire_at IS NULL OR COALESCE(MIN(${k}.expires_at,${k}.retire_at),${k}.expires_at,${k}.retire_at)>?) AND (${k}.kind<>'personal' OR EXISTS(SELECT 1 FROM org_memberships p JOIN users u ON u.id=p.user_id WHERE p.id=${k}.membership_id AND p.revoked_at IS NULL AND u.status='active')))`,
    params: [now],
  };
}

/**
 * The key holds `scope`: listed, or in the preset of one of its roles. A personal key also needs its
 * member's current roles to grant what the scope exercises, so it never outlives a demotion.
 */
export function keyHoldsScope(k: string, scope: string): Fragment {
  return {
    sql: `((EXISTS(SELECT 1 FROM json_each(${k}.scopes) s WHERE s.value=?) OR EXISTS(SELECT 1 FROM json_each(${k}.roles) r WHERE r.value IN (${roleList(rolesWithScope(scope))}))) AND (${k}.kind<>'personal' OR EXISTS(SELECT 1 FROM org_memberships c, json_each(c.roles) m WHERE c.id=${k}.membership_id AND m.value IN (${roleList(rolesCapableOf(scope))}))))`,
    params: [scope],
  };
}

/** Collects a fragment's parameters into a statement built left to right. */
export function withParams(into: SqlValue[], fragment: Fragment): string {
  into.push(...fragment.params);
  return fragment.sql;
}
