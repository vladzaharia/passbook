import type { ServiceContext } from '../../platform/service-context.ts';
import { type ActorCsrfSnapshot, actorCsrfSnapshotFence } from './actor-csrf.ts';
import type { CredentialTombstoneSnapshot } from './credential-input.ts';
import type { ScanActor } from './guard.ts';
import { type LookupEntry, lookupHistoryStmts } from './lookup-history.ts';
import { photoGrantUrl } from './member-photo.ts';
import { isReadMissStale, prepareReadMiss } from './misses.ts';
import { actorAuthorityPredicate } from './repo-actor-authority.ts';
import { scanCandidateTemplateReadPredicate } from './repo-live-template-snapshot.ts';
import type { Candidate } from './repo-lookup.ts';
import { andLookupPredicates, lookupPhotoSnapshotPredicate } from './repo-lookup-finalize.ts';
import { type OutputAuthority, outputAuthorityPredicate } from './repo-output-authority.ts';
import { type OutputPredicate, outputPredicateStmt } from './repo-output-predicates.ts';
import {
  capturedReleaseId,
  headReleasesStmt,
  passChanged,
} from './repo-resolve-outcome-current.ts';

export async function finalizeLookup(
  ctx: ServiceContext,
  actor: ScanActor,
  entries: readonly LookupEntry[],
  csrfSnapshot: ActorCsrfSnapshot,
  credentials: CredentialTombstoneSnapshot | null,
  candidatesAt: (now: number) => OutputPredicate,
  observed: readonly Candidate[],
  observedMatches: readonly OutputPredicate[],
  countMiss: boolean,
): Promise<LookupEntry[] | null> {
  if (countMiss && observedMatches.length !== observed.length) return null;
  const db = ctx.env.DB;
  const now = ctx.clock.now();
  const csrf = actorCsrfSnapshotFence(
    actor,
    csrfSnapshot.session
      ? { ...csrfSnapshot, session: { ...csrfSnapshot.session, now } }
      : csrfSnapshot,
  );
  if (!csrf) return null;
  const authority = (source: Candidate, identityOnly = true): OutputAuthority => {
    const template = scanCandidateTemplateReadPredicate(source);
    return {
      actor,
      now,
      event: actor.event,
      templateId: source.pass.templateId,
      credentialTombstoneRefs: source.credentialTombstoneRefs,
      credentialKeysetCommitment: source.credentialKeysetCommitment,
      pass: source.pass,
      connectionGeneration: source.connectionGeneration,
      activeTemplateVersion: source.activeTemplateVersion,
      orgRevision: source.orgRevision,
      templateRevision: source.templateRevision,
      release: source,
      displayTemplateVersion: source.displayTemplateVersion,
      checkInRules: source.checkInRules,
      lookupHash: source.lookupHash,
      requireActive: true,
      ...(identityOnly ? { imagePolicy: 'identity-only' as const } : {}),
      extra: andLookupPredicates(csrf, template),
    };
  };
  const plans = entries.map((entry) => {
    const predicate = outputAuthorityPredicate(authority(entry.source));
    // The photo is shown only while the pass still has the photo the capability was minted for.
    const photo =
      entry.photoGrant && entry.photoGrant.grant.expiresAt > now
        ? [
            outputPredicateStmt(
              db,
              andLookupPredicates(
                lookupPhotoSnapshotPredicate(entry.source),
                outputAuthorityPredicate({ ...authority(entry.source, false), requirePhoto: true }),
              ),
            ),
          ]
        : [];
    return { predicate, photo };
  });
  const actorAuthority = actorAuthorityPredicate({
    actor,
    now,
    event: actor.event,
    adminEventTemplates: actor.adminEventTemplates === true,
  });
  const actorFence = outputPredicateStmt(db, andLookupPredicates(actorAuthority, csrf));
  const histories = entries.map((entry) =>
    entry.history ? lookupHistoryStmts(db, entry.history, now) : [],
  );
  const statements: D1PreparedStatement[] = [];
  for (const [index] of entries.entries()) {
    const plan = plans[index];
    const history = histories[index];
    if (!plan || !history) throw new Error('Missing lookup output plan');
    statements.push(outputPredicateStmt(db, plan.predicate), ...history);
    statements.push(...plan.photo);
  }
  const miss = countMiss
    ? prepareReadMiss({ ...ctx, clock: { now: () => now } }, actor, {
        csrf,
        credentials,
        visible: plans.map((plan) => plan.predicate),
        candidates: candidatesAt(now),
        assertions: observed.flatMap((source, index) => {
          const predicate = outputAuthorityPredicate(authority(source));
          const match = observedMatches[index];
          if (!match) throw new Error('Missing lookup candidate match');
          return [predicate, match];
        }),
      })
    : null;
  const actorIndex = statements.length;
  statements.push(actorFence, ...(miss?.stmts ?? []));
  const headIndex = statements.length;
  statements.push(
    headReleasesStmt(
      db,
      actor.orgId,
      entries.map((entry) => entry.source.pass.id),
    ),
  );
  let results: D1Result<Record<string, unknown>>[];
  try {
    results = await db.batch<Record<string, unknown>>(statements);
  } catch (error) {
    if (isReadMissStale(error)) return null;
    throw error;
  }
  if (results[actorIndex]?.results?.[0]?.authorized !== 1) return null;
  const missStatus = miss ? miss.result(results.slice(actorIndex + 1, headIndex)) : null;
  if (miss && missStatus) miss.throwIfCapped(missStatus);
  const visible: LookupEntry[] = [];
  const lost: Candidate[] = [];
  let at = 0;
  for (const [index, entry] of entries.entries()) {
    const authorized = results[at++]?.results?.[0]?.authorized === 1;
    const history = histories[index];
    const plan = plans[index];
    if (!history || !plan) throw new Error('Missing lookup output plan');
    const historyCurrent =
      history.length > 0 &&
      history.every((_, offset) => results[at + offset]?.results?.[0]?.authorized === 1);
    at += history.length;
    const photoAuthorized = plan.photo.length > 0 && results[at]?.results?.[0]?.authorized === 1;
    at += plan.photo.length;
    if (!authorized) {
      lost.push(entry.source);
      continue;
    }
    entry.item.lastScanAt = historyCurrent ? entry.item.lastScanAt : null;
    entry.item.photoUrl =
      photoAuthorized && entry.photoGrant
        ? photoGrantUrl(actor, entry.source.pass.id, entry.photoGrant.grant)
        : null;
    visible.push(entry);
  }
  // A release that changed how the pass is used is a real race, not an absent pass.
  const heads = new Map(
    ((results[headIndex]?.results ?? []) as { id: string; releaseId: string | null }[]).map(
      (row) => [row.id, row.releaseId],
    ),
  );
  for (const source of lost)
    if (heads.has(source.pass.id) && heads.get(source.pass.id) !== capturedReleaseId(source))
      throw passChanged();
  if (visible.length === 0 && (entries.length > 0 || missStatus === 'not_committed')) return null;
  return visible;
}
