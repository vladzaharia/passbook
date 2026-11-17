import type { SqlValue } from '../../platform/db.ts';
import type { Pass } from '../passes/repo-map.ts';
import type { ScanActor } from './actor.ts';
import { effectiveReleaseIs, usedRelease } from './effective-release.ts';
import { validCredentialTombstoneRefs } from './repo-credential-tombstones.ts';
import type { Candidate } from './repo-lookup.ts';
import { passVisibleSql } from './repo-pass-visible.ts';
import type { StrictReadAuthority } from './repo-read-authority.ts';
import { actorPassScopeSql } from './repo-recipient-scope.ts';

/** A SQL boolean and its binds, in text order. */
export interface Fence {
  sql: string;
  params: SqlValue[];
}

/** The tenant of the actor's own read: the `actor_ok` row of its authority. */
export const ACTOR_TENANT = { org: 'actor_ok.org_id', mode: 'actor_ok.mode' } as const;

/**
 * A scalar fence for a caller that takes a predicate (a batch's authority term): the actor's authority
 * holds, and so does `inner`, which may name the tenant as `actor_ok.org_id` and `actor_ok.mode`.
 */
export function underAuthority(auth: StrictReadAuthority, inner: Fence): Fence {
  return {
    sql: `EXISTS (WITH ${auth.ctes} SELECT 1 FROM actor_ok WHERE ${inner.sql})`,
    params: [...auth.params, ...inner.params],
  };
}

/** The mode a cross-mode detection also checks, as a SQL literal. */
export const otherModeSql = (mode: 'live' | 'test') => (mode === 'live' ? "'test'" : "'live'");

/**
 * None of the credential's keyed refs is retired by a transfer in the tenant (SQL expressions for its
 * org and mode). Null for refs that are not keyed digests. The keyset itself is pinned once by the
 * request's candidate read.
 */
export function refsClear(
  refs: readonly string[] | undefined,
  tenant: { org: string; mode: string } = ACTOR_TENANT,
): Fence | null {
  if (!validCredentialTombstoneRefs(refs)) return null;
  if (refs.length === 0) return { sql: '1', params: [] };
  return {
    sql: `NOT EXISTS (SELECT 1 FROM pass_credential_tombstones tomb
      WHERE tomb.org_id = ${tenant.org} AND tomb.mode = ${tenant.mode}
        AND tomb.credential_hash IN (SELECT value FROM json_each(?)))`,
    params: [JSON.stringify(refs)],
  };
}

/**
 * The pass a scan read answered from is still what the read saw: live at its credential and lifecycle
 * generations, no transfer pending, its template and connection usable, under the release it was used
 * under (and, with a photo, at its image generation), inside the actor's scope, and its credential not
 * retired. Content (personalization, Wallet JSON, version) is not authority. Over the actor's tenant:
 * use inside `underAuthority`. Null when the actor's scope accepts nothing or a part is malformed.
 */
export function passAnswerFence(
  actor: ScanActor,
  candidate: Pick<Candidate, 'pass' | 'templateSnapshot'>,
  input: { photo: boolean; refs: readonly string[] | undefined },
): Fence | null {
  const scope = actorPassScopeSql(actor, 'p');
  const release = usedRelease(candidate.templateSnapshot?.raw);
  const refs = refsClear(input.refs);
  if (!scope || release === false || !refs) return null;
  const { pass } = candidate;
  return {
    sql: `EXISTS (SELECT 1 FROM passes p
      WHERE p.id = ? AND p.org_id = ${ACTOR_TENANT.org} AND p.mode = ${ACTOR_TENANT.mode}
        AND ${passVisibleSql('p', { credential: '?', lifecycle: '?' })}
        ${input.photo ? 'AND p.image_generation = ?' : ''}
        AND ${effectiveReleaseIs('p')} AND ${scope.sql}
        AND ${refs.sql})`,
    params: [
      pass.id,
      pass.credentialGeneration,
      pass.lifecycleGeneration,
      ...(input.photo ? [pass.imageGeneration] : []),
      release === null ? null : release[0],
      ...scope.params,
      ...refs.params,
    ],
  };
}

/**
 * A pass the answer names without showing it (a voided, removed, expired or other-mode pass) is still
 * the same pass: not deleted or quarantined, at the generations the read saw, no transfer pending.
 * `scoped` adds the actor's own scope (a refusal for a pass the actor may handle). Over the actor's org.
 */
export function passLineageFence(
  actor: ScanActor,
  pass: Pick<Pass, 'id' | 'mode' | 'credentialGeneration' | 'lifecycleGeneration'>,
  scoped: boolean,
): Fence | null {
  const scope = scoped ? actorPassScopeSql(actor, 'p') : { sql: '1', params: [] };
  if (!scope) return null;
  return {
    sql: `EXISTS (SELECT 1 FROM passes p
      WHERE p.id = ? AND p.org_id = ${ACTOR_TENANT.org} AND p.mode = ?
        AND p.deleted_at IS NULL AND p.test_data_quarantined = 0
        AND p.credential_generation = ? AND p.lifecycle_generation = ?
        AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers t
          WHERE t.pass_id = p.id AND t.state = 'pending')
        AND ${scope.sql})`,
    params: [
      pass.id,
      pass.mode,
      pass.credentialGeneration,
      pass.lifecycleGeneration,
      ...scope.params,
    ],
  };
}
