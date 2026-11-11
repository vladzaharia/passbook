import type { ServiceContext } from '../../platform/service-context.ts';
import { type ActorCsrfSnapshot, actorCsrfSnapshotFence } from './actor-csrf.ts';
import type { CredentialTombstoneSnapshot } from './credential-input.ts';
import type { ScanActor } from './guard.ts';
import { type LookupEntry, lookupHistoryStmts } from './lookup-history.ts';
import { confirmedPhotoUrl } from './member-photo.ts';
import { isReadMissStale, prepareReadMiss } from './misses.ts';
import { actorAuthorityPredicate } from './repo-actor-authority.ts';
import { isAssetGrantAuthorityFailure, prepareAssetGrantInsertion } from './repo-asset-grants.ts';
import { scanCandidateTemplateReadPredicate } from './repo-live-template-snapshot.ts';
import type { Candidate } from './repo-lookup.ts';
import {
  andLookupPredicates,
  deniedLookupPredicate,
  lookupPhotoSnapshotPredicate,
} from './repo-lookup-finalize.ts';
import { type OutputAuthority, outputAuthorityPredicate } from './repo-output-authority.ts';
import { type OutputPredicate, outputPredicateStmt } from './repo-output-predicates.ts';

export async function finalizeLookup(
  ctx: ServiceContext,
  actor: ScanActor,
  entries: readonly LookupEntry[],
  csrfResult: D1Result | undefined,
  csrfSnapshot: ActorCsrfSnapshot,
  credentials: CredentialTombstoneSnapshot | null,
  candidatesAt: (now: number) => OutputPredicate,
  observed: readonly Candidate[],
  observedMatches: readonly OutputPredicate[],
  countMiss: boolean,
): Promise<LookupEntry[] | null> {
  if (countMiss && observedMatches.length !== observed.length) return null;
  const db = ctx.env.DB;
  const prepared = await Promise.all(
    entries.map(async (entry) => {
      const requiredPhoto = lookupPhotoSnapshotPredicate(entry.source);
      if (!entry.photoGrant) return null;
      const insert = await prepareAssetGrantInsertion(
        ctx,
        entry.photoGrant.grant,
        { recipient: csrfResult },
        entry.source,
      );
      return { insert, requiredPhoto };
    }),
  );
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
  const plans = entries.map((entry, index) => {
    const predicate = outputAuthorityPredicate(authority(entry.source));
    const preparedPhoto = prepared[index];
    const photoAuthority = preparedPhoto
      ? outputAuthorityPredicate({ ...authority(entry.source, false), requirePhoto: true })
      : null;
    const photo =
      preparedPhoto && photoAuthority
        ? preparedPhoto.insert(
            now,
            photoAuthority,
            entry.photoGrant && entry.photoGrant.grant.expiresAt > now
              ? andLookupPredicates(preparedPhoto.requiredPhoto, photoAuthority)
              : deniedLookupPredicate(),
          )
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
  let results: D1Result<Record<string, unknown>>[];
  try {
    results = await db.batch<Record<string, unknown>>(statements);
  } catch (error) {
    if (isAssetGrantAuthorityFailure(error) || isReadMissStale(error)) return null;
    throw error;
  }
  if (results[actorIndex]?.results?.[0]?.authorized !== 1) return null;
  const missStatus = miss
    ? miss.result(results.slice(actorIndex + 1, actorIndex + 1 + miss.stmts.length))
    : null;
  if (miss && missStatus) miss.throwIfCapped(missStatus);
  const visible: LookupEntry[] = [];
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
    const photo = plan.photo;
    const photoResults = results.slice(at, at + photo.length);
    at += photo.length;
    if (!authorized) continue;
    entry.item.lastScanAt = historyCurrent ? entry.item.lastScanAt : null;
    entry.item.photoUrl =
      photo.length && entry.photoGrant
        ? confirmedPhotoUrl(actor, entry.source.pass.id, entry.photoGrant.grant, photoResults)
        : null;
    visible.push(entry);
  }
  if (visible.length === 0 && (entries.length > 0 || missStatus === 'not_committed')) return null;
  return visible;
}
