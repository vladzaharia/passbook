import { rolesCapableOf, rolesWithScope } from './api-scopes.ts';
import type { SqlValue } from './db.ts';

/** A SQL fragment with its `?` parameters, in text order. */
export interface Fragment {
  sql: string;
  params: SqlValue[];
}

/**
 * The key row `k` is in force at `now`: not revoked, not past `expires_at` or `retire_at`, not a key whose
 * template restrictions no grant enforces yet, and, for a personal key, its membership is live and its
 * user active. One definition for every statement that asks "may this key act".
 */
export function keyLive(k: string, now: number): Fragment {
  return {
    sql: `(${k}.revoked_at IS NULL AND (${k}.expires_at IS NULL OR ${k}.expires_at > ?)
      AND (${k}.retire_at IS NULL OR ${k}.retire_at > ?) AND ${k}.restricted = 0
      AND (${k}.kind <> 'personal' OR EXISTS (SELECT 1 FROM org_memberships pm JOIN users pu ON pu.id = pm.user_id
        WHERE pm.id = ${k}.membership_id AND pm.org_id = ${k}.org_id AND pm.revoked_at IS NULL AND pu.status = 'active')))`,
    params: [now, now],
  };
}

/**
 * The key holds `scope`: listed, or in the preset of one of its roles. A personal key also needs its
 * member's current roles to grant what the scope exercises, so it never outlives a demotion.
 */
export function keyHoldsScope(k: string, scope: string): Fragment {
  return {
    sql: `((EXISTS (SELECT 1 FROM json_each(${k}.scopes) hs WHERE hs.type = 'text' AND hs.value = ?)
        OR EXISTS (SELECT 1 FROM json_each(${k}.roles) hr WHERE hr.type = 'text'
          AND hr.value IN (SELECT value FROM json_each(?))))
      AND (${k}.kind <> 'personal' OR EXISTS (SELECT 1 FROM org_memberships cm WHERE cm.id = ${k}.membership_id
        AND EXISTS (SELECT 1 FROM json_each(cm.roles) cr WHERE cr.type = 'text'
          AND cr.value IN (SELECT value FROM json_each(?))))))`,
    params: [scope, JSON.stringify(rolesWithScope(scope)), JSON.stringify(rolesCapableOf(scope))],
  };
}

/** Collects a fragment's parameters into a statement built left to right. */
export function withParams(into: SqlValue[], fragment: Fragment): string {
  into.push(...fragment.params);
  return fragment.sql;
}
