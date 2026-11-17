import type { z } from 'zod';
import type { ScanLookupResultSchema } from '../../../shared/contracts/scan-session.ts';
import { strictEmail } from '../../../shared/email.ts';
import { bumpIfStmt } from '../../platform/counters.ts';
import { ForbiddenError, RateLimitedError } from '../../platform/errors.ts';
import { enforceRateLimit } from '../../platform/rate-limit.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { auditStmt } from '../audit/repo.ts';
import { depsOf, overrideDeps } from '../passes/deps.ts';
import { credentialRefKeysetInitializeStmt } from '../passes/repo-credential-keyset.ts';
import { decodePlatformSettings, platformSettingsStmt } from '../settings/service.ts';
import { visibleIdentity } from './card-semantics.ts';
import { scanCredentialKeys, snapshotCredentialEnv } from './credential-input.ts';
import { policyActor } from './dto.ts';
import { cardPrivacy } from './dto-projection.ts';
import type { ScanActor } from './guard.ts';
import { planHistoryProofSnapshotsForOrg } from './history-proof-plan.ts';
import { finalizeLookup } from './lookup-finalize.ts';
import { attachLookupHistory, type LookupEntry } from './lookup-history.ts';
import { knownPhotoUrl } from './member-photo.ts';
import { grantReadMiss } from './misses.ts';
import { byIdStmt, type Candidate, candidatesOf } from './repo-lookup.ts';
import { lookupGateStmt } from './repo-lookup-final.ts';
import { scanReadAuthority, scanReadFence } from './repo-read-authority.ts';
import {
  type SearchRow,
  searchPassesStmt,
  searchRowsOf,
  searchWindowUnchanged,
} from './repo-search.ts';
import { foundOf } from './resolve.ts';
import { scanPolicy } from './rules.ts';
import { cloneObservedScanActor } from './scanning-workspace-observation.ts';

/** Search pages of 50 examined before a lookup answers `more` instead of reading on. */
const LOOKUP_MAX_PAGES = 4;

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
  const [settingsResult, counterResult] = await ctx.env.DB.batch<Record<string, unknown>>([
    platformSettingsStmt(ctx.env.DB),
    bumpIfStmt(ctx.env.DB, `scan:lk:${actor.actorKey}`, hour, { sql: '1', params: [] }),
  ]);
  if (!settingsResult) throw new Error('Missing lookup settings result');
  const maximum = decodePlatformSettings(settingsResult)['scan.lookupsPerHour'];
  const count = counterResult?.results?.[0]?.count;
  if (typeof count === 'number' && count > maximum)
    throw new RateLimitedError(Math.ceil((hour + 3_600_000 - now) / 1000));

  const q = raw.trim();
  const email = strictEmail(q);
  const keys = q ? await scanCredentialKeys(ctx.env, actor.orgId, actor.mode, q, false) : undefined;
  if (keys) actor = { ...actor, credentialKeysetCommitment: keys.credentialKeysetCommitment };
  const directMatch = (candidate: Candidate) =>
    (email !== null && candidate.pass.holderEmail === email) ||
    candidate.pass.id === q ||
    candidate.pass.serial === q ||
    candidate.pass.externalId === q ||
    (keys !== undefined &&
      ((keys.scanCode !== null && candidate.pass.scanCode === keys.scanCode) ||
        candidate.pass.barcodeHash === keys.barcodeHash ||
        candidate.lookupHash === keys.lookupHash));
  let firstRows: SearchRow[] = [];
  if (keys) {
    const guardNow = ctx.clock.now();
    const auth = scanReadAuthority(actor, { now: guardNow });
    const search = searchPassesStmt(
      ctx.env.DB,
      actor,
      q,
      email,
      keys,
      guardNow,
      0,
      keys.credentialTombstoneRefs,
    );
    const results = await ctx.env.DB.batch<Record<string, unknown>>([
      credentialRefKeysetInitializeStmt(
        ctx.env.DB,
        keys.credentialKeysetCommitment,
        scanReadFence(auth),
      ),
      // The stored keyset is the one this request's refs were keyed with (it is an immutable singleton).
      lookupGateStmt(ctx.env.DB, auth),
      ...(search ? [search] : []),
    ]);
    const gate = results[1]?.results?.[0];
    if (gate?.authorized !== 1 || gate.keyset !== keys.credentialKeysetCommitment)
      return { items: [], more: false };
    firstRows = search ? searchRowsOf(results[2]) : [];
  }

  let offset = 0;
  let pages = 0;
  let rows = firstRows;
  let entries: LookupEntry[] = [];
  let visible: LookupEntry[] = [];
  let uncertain = false;
  let capped = false;
  const hidden: Candidate[] = [];
  const seen = new Set<string>();
  for (;;) {
    if (rows.length && keys) {
      pages += 1;
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
    // Hidden rows still cost a projection each: stop after a bounded scan and answer `more`.
    capped = !exhausted && pages >= LOOKUP_MAX_PAGES;
    if (entries.length >= 11 || exhausted || capped) {
      const countMiss = exhausted && !uncertain && entries.length === 0;
      // An empty page that is a miss has nothing to disclose: the miss's own grant holds the actor.
      const final = countMiss
        ? []
        : await finalizeLookup(ctx, actor, entries, keys?.credentialTombstoneRefs ?? []);
      if (!final) return { items: [], more: false };
      if (final.length !== entries.length) uncertain = true;
      // A miss is counted in its own grant: the search window is the one the read saw.
      if (countMiss && final.length === 0) {
        const unchanged = keys
          ? searchWindowUnchanged(
              actor,
              q,
              email,
              keys,
              ctx.clock.now(),
              keys.credentialTombstoneRefs,
              hidden.length,
            )
          : { sql: '{org} IS NOT NULL', params: [] };
        if (
          !unchanged ||
          (await grantReadMiss(ctx, actor, {
            refs: keys?.credentialTombstoneRefs ?? [],
            unchanged,
          })) !== 'counted'
        )
          return { items: [], more: false };
      }
      visible = final;
      if (visible.length >= 11 || exhausted || capped) break;
      // New pages require a new final transaction.
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
  return {
    items: visible.slice(0, 10).map(({ item }) => item),
    more: visible.length > 10 || capped,
  };
}
