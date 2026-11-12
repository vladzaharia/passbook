import { BAKED_BUILD_HASH, bakedTemplates } from '../../../generated/baked-templates.ts';
import type { AssetEntry, PassJson } from '../../../passkit/types.ts';
import { SYNC_CONFLICT, templateSyncGrant } from '../../jobs/template-sync.ts';
import { grantedBatch } from '../../platform/authority.ts';
import { ConflictError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { BakedTemplate } from './baked-types.ts';
import { buildKey } from './package/hash.ts';
import {
  APPLE_ADAPTER_CAPABILITIES,
  APPLE_ADAPTER_REVISION,
  AUDIENCE_POLICY_REVISION,
  candidateHash,
  ReleaseContentError,
} from './release-content.ts';
import { type NewVersion, versionContentMatches } from './repo.ts';
import { grantRow, inGrant } from './repo-grants.ts';
import {
  addVersionExtra,
  sealVersionExtras,
  versionExtrasSnapshot,
} from './repo-preview-extras.ts';
import {
  bakedAdoptionSnapshot,
  bakedOrgId,
  bakedSyncComplete,
  bakedTemplateSnapshot,
  bakedVersionSnapshot,
  staleBakedIds,
} from './repo-sync.ts';
import {
  bakedExtrasUnchanged,
  bakedOrgUnchanged,
  bakedTemplateUnchanged,
  bakedVersionUnchanged,
} from './repo-sync-checks.ts';
import {
  addAdoption,
  addArchiveStale,
  addBakedOrg,
  addBakedTemplate,
  addVersion,
  adoptionCheck,
} from './repo-sync-writes.ts';
import { versionHashesSql } from './repo-version-hashes.ts';
import { type Adoption, readAdoption, selectAdoption, workerAdoption } from './sync-adoption.ts';
import { bakedR2Key, type PreparedContent, releaseContent } from './sync-content.ts';
import { planBakedReleases, type Unit } from './sync-releases.ts';

export { bakedExtraR2Key, bakedR2Key } from './sync-content.ts';

export interface SyncSource {
  templates: readonly BakedTemplate[];
  hash: string;
}

export const generatedSource: SyncSource = { templates: bakedTemplates, hash: BAKED_BUILD_HASH };

// Never cache an incomplete sync; each database and Worker build has its own settled state.
// `value` is the stored adoption this build settled against; `skipped` marks an older build that
// serves the database as it is.
interface Settled {
  value: string | null;
  skipped: boolean;
}
const BACKOFF_MS = 30_000;
/** After two refused syncs in a row, requests serve the database as it is until this time. */
let backoff = new WeakMap<object, number>();
const isSyncConflict = (error: unknown) =>
  error instanceof ConflictError && error.code === SYNC_CONFLICT;
let done = new WeakMap<object, Map<string, Settled>>();

/** Test hook: forget settled syncs. */
export function resetBakedSync(): void {
  done = new WeakMap();
  backoff = new WeakMap();
}

function r2Assets(t: BakedTemplate): AssetEntry[] {
  return t.assets.map((a) => ({
    ...a,
    source: { kind: 'r2' as const, key: bakedR2Key(t.slug, t.version, a.name) },
  }));
}

function complete(db: D1Database, source: SyncSource, value: string): Promise<boolean> {
  return bakedSyncComplete(db, value, source.hash, source.templates, {
    adapterRevision: APPLE_ADAPTER_REVISION,
    adapterCapabilities: APPLE_ADAPTER_CAPABILITIES,
    audiencePolicyRevision: AUDIENCE_POLICY_REVISION,
  });
}

async function sync(
  ctx: ServiceContext,
  source: SyncSource,
  adoption: Adoption,
  cold: boolean,
): Promise<Settled | null> {
  const db = ctx.env.DB;
  const state = await bakedAdoptionSnapshot(db);
  const current = readAdoption(state.value);
  const selected = selectAdoption(current, adoption, state.legacy, state.legacyUpdatedAt);
  // A cold isolate trusts the stored, sealed copy of an equal hash instead of re-copying and
  // re-hashing every asset; a warm one has already settled this database and still compares content.
  if (
    cold &&
    state.value !== null &&
    current?.hash === adoption.hash &&
    (await complete(db, source, state.value))
  )
    return { value: state.value, skipped: false };
  // An older build serves what a newer one stored; only writes are fenced.
  if (selected.stale) {
    // The same content needs no write, and nothing to report, whichever build serves it.
    if (current?.hash === adoption.hash) return { value: state.value, skipped: true };
    ctx.log.warn('templates.baked_sync_skipped', {
      code: 'TEMPLATE_BUILD_SUPERSEDED',
      workerId: adoption.workerId,
    });
    return { value: state.value, skipped: true };
  }
  const now = ctx.clock.now();
  // One grant per unit keeps each grant's checks inside the bind budget; all units commit as one batch.
  // Statements are collected first: a grant's checks (adoption marker, snapshots, each scope's head)
  // are fixed when it is created, and its writes run after them.
  const head: Unit = { checks: [adoptionCheck(state)], steps: [] };
  const units: Unit[] = [head];
  const orgs = new Map<string, { id: string; name: string }>();
  for (const t of source.templates) {
    if (!t.org || orgs.has(t.org.slug)) continue;
    const slug = t.org.slug;
    const stored = await bakedOrgId(db, slug);
    const org = { id: stored?.id ?? ctx.ids.id(), name: t.org.name };
    orgs.set(slug, org);
    head.checks.push(bakedOrgUnchanged(slug, stored?.id ?? null));
    if (!stored) head.steps.push((g) => addBakedOrg(g, { id: org.id, slug, name: org.name, now }));
  }

  let settled = true;
  for (const t of source.templates) {
    const template = await bakedTemplateSnapshot(db, t.id);
    const version = await bakedVersionSnapshot(db, t.id, t.version);
    const extraSnapshot = await versionExtrasSnapshot(db, t.id, t.version);
    if (template && template.origin !== 'baked')
      throw new Error(`Baked template id is already in use: ${t.id}`);
    const orgId = template ? template.org_id : t.org ? (orgs.get(t.org.slug)?.id ?? null) : null;
    const unit: Unit = {
      checks: [
        bakedTemplateUnchanged(t.id, template),
        bakedVersionUnchanged(t.id, t.version, version),
        bakedExtrasUnchanged(t.id, t.version, extraSnapshot),
      ],
      steps: [],
    };
    units.push(unit);

    // Keep even an unverified draft pointed at the immutable copies populated by a later retry.
    const assets = r2Assets(t);
    const incoming: NewVersion = {
      templateId: t.id,
      version: t.version,
      buildKey: await buildKey(t),
      manifest: t.manifest,
      passJson: t.passJson as PassJson,
      assets,
      report: t.report,
      createdBy: null,
      createdAt: now,
    };
    if (version && !versionContentMatches(version, incoming))
      throw new ConflictError(
        `Baked version conflicts with its stored content: ${t.id}`,
        'TEMPLATE_VERSION_CONTENT_CONFLICT',
      );
    let prepared: PreparedContent | null = null;
    try {
      prepared = await releaseContent(ctx, t, version, assets, extraSnapshot);
    } catch (error) {
      if (!(error instanceof ReleaseContentError)) throw error;
      settled = false;
      ctx.log.warn('templates.baked_release_unavailable', {
        code: 'BAKED_RELEASE_CONTENT_UNAVAILABLE',
        templateId: t.id,
        error,
      });
    }

    unit.steps.push((g) =>
      addBakedTemplate(
        g,
        {
          id: t.id,
          orgId,
          slug: t.slug,
          name: t.name,
          description: t.description,
          version: t.version,
          styles: t.styles,
          now,
        },
        template,
      ),
    );
    if (!version) unit.steps.push((g) => addVersion(g, incoming));

    if (prepared && extraSnapshot.seal === null) {
      const alreadyStored = new Set(extraSnapshot.extras.map((extra) => extra.name));
      const { extras, extrasHash } = prepared;
      for (const extra of extras)
        if (!alreadyStored.has(extra.name))
          unit.steps.push((g) => addVersionExtra(g, t.id, t.version, extra));
      unit.steps.push((g) => sealVersionExtras(g, t.id, t.version, extrasHash));
    }

    if (prepared !== null) {
      const { contentHash, assetHashes } = prepared;
      unit.steps.push((g) => {
        const h = versionHashesSql(t.id, t.version, { contentHash, assetHashes }, now);
        const gate = grantRow(g);
        g.add(inGrant(g, `${h.sql} AND ${gate.sql}`, [...h.params, ...gate.params]));
      });
      const planned = await planBakedReleases(ctx, {
        template: t,
        orgId,
        contentHash,
        replaceHead: selected.replaceHead,
        allowLegacyBackfill: version !== null && extraSnapshot.seal === null,
        now,
      });
      unit.checks.push(...planned.checks);
      unit.steps.push(...planned.steps);
    }
  }

  const stale = await staleBakedIds(
    db,
    source.templates.map((t) => t.id),
  );
  head.steps.push((g) => {
    addArchiveStale(g, stale, now);
    addAdoption(g, JSON.stringify(selected.value), source.hash, now);
  });
  const grants = units.map((unit) => {
    const g = templateSyncGrant(ctx, unit.checks);
    for (const step of unit.steps) step(g);
    return g;
  });
  try {
    await grantedBatch(db, grants);
  } catch (error) {
    if (error instanceof Error && /malformed json/i.test(error.message))
      throw new ConflictError(
        'The baked template content changed during synchronization.',
        'TEMPLATE_VERSION_CONTENT_CONFLICT',
      );
    throw error;
  }
  ctx.log.info('templates.baked_synced', { count: source.templates.length });
  return settled ? { value: JSON.stringify(selected.value), skipped: false } : null;
}

/** Sync metadata atomically and publish verified baked content as system-owned releases. */
export async function syncBakedTemplates(
  ctx: ServiceContext,
  source: SyncSource = generatedSource,
): Promise<void> {
  const db = ctx.env.DB;
  const adoption = workerAdoption(ctx, source.hash);
  // The generated hash identifies versions, not all of their immutable content.
  const cacheKey = await candidateHash({ adoption, templates: source.templates });
  const settled = done.get(db)?.get(cacheKey);
  if (settled) {
    if (settled.skipped) {
      if ((await bakedAdoptionSnapshot(db)).value === settled.value) return;
    } else if (settled.value !== null && (await complete(db, source, settled.value))) return;
  }
  const now = ctx.clock.now();
  if ((backoff.get(db) ?? 0) > now) return;
  let result: Settled | null = null;
  try {
    result = await sync(ctx, source, adoption, !done.has(db));
  } catch (error) {
    if (!isSyncConflict(error)) throw error;
    // Another build or administrator wrote between our reads and the grant: read again once.
    ctx.log.warn('templates.baked_sync_retry', { code: SYNC_CONFLICT });
    try {
      result = await sync(ctx, source, adoption, false);
    } catch (again) {
      if (!isSyncConflict(again)) throw again;
      // A read path never fails for this: the other writer settled it. Skip syncing for a while.
      ctx.log.warn('templates.baked_sync_contended', { code: SYNC_CONFLICT });
      backoff.set(db, now + BACKOFF_MS);
    }
  }
  if (result) {
    const builds = done.get(db) ?? new Map<string, Settled>();
    builds.set(cacheKey, result);
    done.set(db, builds);
  }
}
