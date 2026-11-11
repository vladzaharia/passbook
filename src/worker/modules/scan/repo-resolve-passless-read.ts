import type { ScanActor } from './guard.ts';
import { eventPassPredicate } from './repo-action-authority.ts';
import { actorAuthorityPredicate } from './repo-actor-authority.ts';
import { noCredentialTombstonesSql } from './repo-credential-tombstones.ts';
import type { OutputPredicate } from './repo-output-predicates.ts';
import { type CandidateMatchInput, candidateMatchPredicate } from './repo-resolve-candidates.ts';

/** Any newly matching or pending same-mode credential makes a missing result unconfirmed. */
export function inputCandidatesPredicate(
  actor: Pick<ScanActor, 'orgId' | 'mode'>,
  input: CandidateMatchInput | null,
  filter?: OutputPredicate,
): OutputPredicate {
  if (!input) return { sql: '0', params: [] };
  const matches = candidateMatchPredicate(input);
  return {
    sql: `EXISTS (SELECT 1 FROM passes p WHERE p.org_id=? AND p.mode=?
      AND (${matches.sql})${filter ? ` AND (${filter.sql})` : ''})`,
    params: [actor.orgId, actor.mode, ...matches.params, ...(filter?.params ?? [])],
  };
}

export const candidateEligible: OutputPredicate = {
  sql: 'p.deleted_at IS NULL AND p.test_data_quarantined=0',
  params: [],
};

/** Current acceptance/event scope for a newly appearing candidate of a passless result. */
export function acceptedFilter(actor: ScanActor, includeEvent: boolean): OutputPredicate {
  const scoped = actor.templateIds.length
    ? {
        sql: "p.template_id IN (SELECT value FROM json_each(?/* scan-ephemeral-template-ids */) WHERE type='text')",
        params: [JSON.stringify(actor.templateIds)],
      }
    : {
        sql:
          (actor.principal === 'admin' && actor.scanner === null) ||
          actor.settings.acceptAllTemplates === true
            ? '1'
            : '0',
        params: [],
      };
  if (!includeEvent)
    return { sql: `(${candidateEligible.sql}) AND (${scoped.sql})`, params: scoped.params };
  const event = eventPassPredicate(actor, actor.event);
  return {
    sql: `(${candidateEligible.sql}) AND (${scoped.sql}) AND (${event.sql})`,
    params: [...scoped.params, ...event.params],
  };
}

/** Actor-only reasons must not disclose a credential retired since candidate resolution. */
export function inputActorFence(
  actor: ScanActor,
  csrf: OutputPredicate,
  refs: readonly string[],
  commitment: string,
  otherRefs: readonly string[] | undefined,
  bothModes: boolean,
  absence: OutputPredicate | undefined,
  now: number,
): OutputPredicate | null {
  const authority = actorAuthorityPredicate({
    actor,
    now,
    event: actor.event,
    adminEventTemplates: actor.adminEventTemplates === true,
  });
  const own = noCredentialTombstonesSql(refs, { orgIdSql: '?', modeSql: '?' }, commitment);
  if (own.sql === '0') return null;
  const parts = [`(${authority.sql})`, `(${csrf.sql})`, `(${own.sql})`];
  const params = [...authority.params, ...csrf.params];
  if (refs.length) params.push(actor.orgId, actor.mode);
  params.push(...own.params);
  if (bothModes) {
    if (!otherRefs) return null;
    const other = noCredentialTombstonesSql(otherRefs, { orgIdSql: '?', modeSql: '?' }, commitment);
    if (other.sql === '0') return null;
    parts.push(`(${other.sql})`);
    if (otherRefs.length) params.push(actor.orgId, actor.mode === 'live' ? 'test' : 'live');
    params.push(...other.params);
  }
  if (absence) {
    parts.push(`NOT COALESCE((${absence.sql}),1)`);
    params.push(...absence.params);
  }
  return { sql: parts.join(' AND '), params };
}
