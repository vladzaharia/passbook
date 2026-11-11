import type { z } from 'zod';
import type { ScanLookupResultSchema } from '../../../shared/contracts/scan-session.ts';
import { strictEmail } from '../../../shared/email.ts';
import { bumpIfStmt } from '../../platform/counters.ts';
import { ForbiddenError, RateLimitedError } from '../../platform/errors.ts';
import { enforceRateLimit } from '../../platform/rate-limit.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { auditStmt } from '../audit/repo.ts';
import { depsOf, overrideDeps } from '../passes/deps.ts';
import {
  credentialRefKeysetInitializeStmt,
  credentialRefKeysetSql,
} from '../passes/repo-credential-keyset.ts';
import { decodePlatformSettings, platformSettingsStmt } from '../settings/service.ts';
import {
  actorCsrfAuthorityStmt,
  actorCsrfSnapshotFence,
  actorCsrfSnapshotFromResult,
} from './actor-csrf.ts';
import { visibleIdentity } from './card-semantics.ts';
import { scanCredentialKeys, snapshotCredentialEnv } from './credential-input.ts';
import { policyActor } from './dto.ts';
import { cardPrivacy } from './dto-projection.ts';
import type { ScanActor } from './guard.ts';
import { planHistoryProofSnapshotsForOrg } from './history-proof-plan.ts';
import { finalizeLookup } from './lookup-finalize.ts';
import { attachLookupHistory, type LookupEntry } from './lookup-history.ts';
import { knownPhotoUrl } from './member-photo.ts';
import { actorAuthorityPredicate } from './repo-actor-authority.ts';
import { byIdStmt, type Candidate, candidatesOf } from './repo-lookup.ts';
import {
  boundOutputPredicate,
  type OutputPredicate,
  outputPredicateStmt,
} from './repo-output-predicates.ts';
import {
  type SearchRow,
  searchInputWindowChangedPredicate,
  searchObservedCandidatePredicate,
  searchPassesStmt,
  searchRowsOf,
} from './repo-search.ts';
import { foundOf } from './resolve.ts';
import { scanPolicy } from './rules.ts';
import { cloneObservedScanActor } from './scanning-workspace-observation.ts';

/** Resolve only role-visible identities and publish grants after one final authority transaction. */
export async function lookup(
  ctx: ServiceContext,
  actor: ScanActor,
  raw: string,
): Promise<z.infer<typeof ScanLookupResultSchema>> {
  const env = snapshotCredentialEnv(ctx.env);
  overrideDeps(env, depsOf(ctx.env));
  ctx = { ...ctx, env };
  actor = cloneObservedScanActor(actor);
  if (!scanPolicy(policyActor(actor), { kind: 'search' }).allow)
    throw new ForbiddenError('Lookup is disabled for this scanner.', 'SCAN_LOOKUP_DISABLED');
  await enforceRateLimit(ctx.env, 'RL_SCAN_LOOKUP', actor.actorKey);
  const now = ctx.clock.now();
  const hour = now - (now % 3_600_000);
  const csrfStmt = actorCsrfAuthorityStmt(ctx.env.DB, actor);
  if (!csrfStmt) return { items: [], more: false };
  const [settingsResult, csrfResult, counterResult] = await ctx.env.DB.batch<
    Record<string, unknown>
  >([
    platformSettingsStmt(ctx.env.DB),
    csrfStmt,
    bumpIfStmt(ctx.env.DB, `scan:lk:${actor.actorKey}`, hour, { sql: '1', params: [] }),
  ]);
  if (!settingsResult) throw new Error('Missing lookup settings result');
  const maximum = decodePlatformSettings(settingsResult)['scan.lookupsPerHour'];
  const count = counterResult?.results?.[0]?.count;
  if (typeof count === 'number' && count > maximum)
    throw new RateLimitedError(Math.ceil((hour + 3_600_000 - now) / 1000));
  const csrfSnapshot = await actorCsrfSnapshotFromResult(ctx, actor, csrfResult);
  if (!csrfSnapshot) return { items: [], more: false };

  const q = raw.trim();
  const email = strictEmail(q);
  const keys = q ? await scanCredentialKeys(ctx.env, actor.orgId, actor.mode, q, false) : undefined;
  if (keys) actor.credentialKeysetCommitment = keys.credentialKeysetCommitment;
  const directMatch = (candidate: Candidate) =>
    (email !== null && candidate.pass.holderEmail === email) ||
    candidate.pass.id === q ||
    candidate.pass.serial === q ||
    candidate.pass.externalId === q ||
    (keys !== undefined &&
      ((keys.scanCode !== null && candidate.pass.scanCode === keys.scanCode) ||
        candidate.pass.barcodeHash === keys.barcodeHash ||
        candidate.lookupHash === keys.lookupHash));
  const guardNow = ctx.clock.now();
  const csrf = actorCsrfSnapshotFence(
    actor,
    csrfSnapshot.session
      ? { ...csrfSnapshot, session: { ...csrfSnapshot.session, now: guardNow } }
      : csrfSnapshot,
  );
  if (!csrf) return { items: [], more: false };
  const actorAuthority = actorAuthorityPredicate({
    actor,
    now: guardNow,
    event: actor.event,
    adminEventTemplates: actor.adminEventTemplates === true,
  });
  const guard: OutputPredicate = {
    sql: `(${actorAuthority.sql}) AND (${csrf.sql})`,
    params: [...actorAuthority.params, ...csrf.params],
  };

  let firstRows: SearchRow[] = [];
  if (keys) {
    const search = searchPassesStmt(
      ctx.env.DB,
      actor,
      q,
      email,
      keys,
      guardNow,
      0,
      keys.credentialTombstoneRefs,
      keys.credentialKeysetCommitment,
    );
    const guarded = boundOutputPredicate(guard);
    const results = await ctx.env.DB.batch<Record<string, unknown>>([
      credentialRefKeysetInitializeStmt(ctx.env.DB, keys.credentialKeysetCommitment, guarded),
      outputPredicateStmt(ctx.env.DB, {
        sql: `(${guard.sql}) AND (${credentialRefKeysetSql})`,
        params: [...guard.params, keys.credentialKeysetCommitment],
      }),
      ...(search ? [search] : []),
    ]);
    if (results[1]?.results?.[0]?.authorized !== 1) return { items: [], more: false };
    firstRows = search ? searchRowsOf(results[2]) : [];
  }

  let offset = 0;
  let rows = firstRows;
  let entries: LookupEntry[] = [];
  let visible: LookupEntry[] = [];
  let uncertain = false;
  const hidden: Candidate[] = [];
  const seen = new Set<string>();
  for (;;) {
    if (rows.length && keys) {
      offset += rows.length;
      const pageRows = rows.filter((row) => {
        if (seen.has(row.id)) return false;
        seen.add(row.id);
        return true;
      });
      const historyPlan = planHistoryProofSnapshotsForOrg(
        ctx,
        {
          orgId: actor.orgId,
          mode: actor.mode,
          credentialKeysetCommitment: keys.credentialKeysetCommitment,
        },
        pageRows.flatMap((row) => (row.last_scan_id ? [row.last_scan_id] : [])),
      );
      const candidateStmts = pageRows.map((row) => byIdStmt(ctx.env.DB, actor.orgId, row.id));
      const results =
        candidateStmts.length || historyPlan.stmts.length
          ? await ctx.env.DB.batch([...candidateStmts, ...historyPlan.stmts])
          : [];
      const candidates = results
        .slice(0, candidateStmts.length)
        .flatMap((result) => candidatesOf(result));
      const history = await historyPlan.finish(results.slice(candidateStmts.length));
      const byId = new Map(candidates.map((candidate) => [candidate.pass.id, candidate]));
      const page = await Promise.all(
        pageRows.map(async (row): Promise<LookupEntry | null> => {
          const candidate = byId.get(row.id);
          if (
            !candidate ||
            candidate.credentialKeysetCommitment !== keys.credentialKeysetCommitment
          ) {
            uncertain = true;
            return null;
          }
          candidate.credentialTombstoneRefs = keys.credentialTombstoneRefs;
          candidate.otherModeCredentialTombstoneRefs = keys.otherModeCredentialTombstoneRefs;
          const found = await foundOf(ctx, candidate, actor);
          if (!found) {
            uncertain = true;
            return null;
          }
          const privacy = cardPrivacy(found, actor);
          const identity = visibleIdentity(found, actor, privacy);
          const prefix = q.toLowerCase();
          const visibleName =
            !email &&
            !q.includes('@') &&
            Array.from(q).length >= 3 &&
            [identity.title, identity.subtitle].some((text) =>
              text?.toLowerCase().startsWith(prefix),
            );
          if (!directMatch(candidate) && !visibleName) {
            hidden.push(candidate);
            return null;
          }
          const photoGrant = candidate.hasPhoto
            ? await knownPhotoUrl(ctx, actor, candidate, found.template, found.activePolicy)
            : null;
          return {
            found,
            source: candidate,
            history: null,
            photoGrant,
            item: {
              passId: found.pass.id,
              title: identity.title ?? '',
              subtitle: identity.subtitle,
              templateName: privacy.safe(found.ref.name) ? found.ref.name : 'Pass',
              status: 'active',
              maskedEmail: null,
              photoUrl: null,
              doorState: null,
              lastScanAt: null,
            },
          };
        }),
      );
      const accepted = page.filter((entry): entry is LookupEntry => entry !== null);
      attachLookupHistory(actor, accepted, pageRows, history);
      entries.push(...accepted);
    }
    const exhausted = !keys || rows.length < 50;
    if (entries.length >= 11 || exhausted) {
      const credentials =
        keys ??
        (actor.credentialKeysetCommitment
          ? {
              credentialKeysetCommitment: actor.credentialKeysetCommitment,
              credentialTombstoneRefs: [],
              otherModeCredentialTombstoneRefs: [],
            }
          : null);
      const countMiss = exhausted && !uncertain && entries.length === 0;
      const observed = [...hidden, ...entries.map((entry) => entry.source)];
      const changed = (finalNow: number) =>
        countMiss && keys
          ? searchInputWindowChangedPredicate(
              actor,
              q,
              email,
              keys,
              finalNow,
              keys.credentialTombstoneRefs,
              keys.credentialKeysetCommitment,
              observed.length,
            )
          : { sql: '0', params: [] };
      const observedMatches = countMiss
        ? observed.map((source) =>
            searchObservedCandidatePredicate(actor, q, email, keys, source.pass.id),
          )
        : [];
      const final = await finalizeLookup(
        ctx,
        actor,
        entries,
        csrfResult,
        csrfSnapshot,
        credentials,
        changed,
        observed,
        observedMatches,
        countMiss,
      );
      if (!final) return { items: [], more: false };
      if (final.length !== entries.length) uncertain = true;
      visible = final;
      if (visible.length >= 11 || exhausted) break;
      // New pages require a new final transaction; never reuse an already inserted grant.
      entries = visible;
      await Promise.all(
        entries.map(async (entry) => {
          if (entry.photoGrant)
            entry.photoGrant = await knownPhotoUrl(
              ctx,
              actor,
              entry.source,
              entry.found.template,
              entry.found.activePolicy,
            );
          entry.item.photoUrl = null;
        }),
      );
    }
    if (!keys) throw new Error('Missing lookup credential keys');
    const next = searchPassesStmt(
      ctx.env.DB,
      actor,
      q,
      email,
      keys,
      now,
      offset,
      keys.credentialTombstoneRefs,
      keys.credentialKeysetCommitment,
    );
    rows = next ? searchRowsOf(await next.all()) : [];
  }
  await auditStmt(ctx.env.DB, ctx, {
    orgId: actor.orgId,
    actorType: actor.actor.type,
    actorId: actor.actor.id,
    action: 'scan.lookup',
    detail: { count: Math.min(visible.length, 10) },
  }).run();
  return { items: visible.slice(0, 10).map(({ item }) => item), more: visible.length > 10 };
}
