import { type MergeResult, mergePackages } from '../../../passkit/template/merge/index.ts';
import type { AssetEntry, ValidationIssue } from '../../../passkit/types.ts';
import type { JobOf } from '../../jobs/types.ts';
import { AppError, ConflictError, type FieldIssue } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { orgBrandingJson } from '../orgs/repo.ts';
import { putVersionAsset } from './asset-storage.ts';
import { forkTip, hasApproval, releaseModes, resolveBase, upstreamReadable } from './fork-base.ts';
import {
  docOf,
  invalidConflicts,
  keptYours,
  sameDoc,
  saveBody,
  summaryOf,
} from './fork-merge-doc.ts';
import { commitMerge, failOffer, type Outcome, settleOffer } from './fork-updates-write.ts';
import { imagesFromBinding } from './images-binding.ts';
import { buildKey } from './package/hash.ts';
import { r2Key } from './registry.ts';
import { templateContentDigest } from './release-content.ts';
import { getTemplate, getVersion } from './repo.ts';
import { FORK_STALE, readForkState } from './repo-fork-update-checks.ts';
import { getForkRow, getOffer, type Offer } from './repo-fork-updates.ts';
import { getVersionHashes } from './repo-version-hashes.ts';
import { checkVersion } from './version-check.ts';

const FAILED = 'TEMPLATE_FORK_UPDATE_FAILED';

const refused = (issues: readonly ValidationIssue[]): FieldIssue[] =>
  issues
    .filter((i) => i.severity === 'error')
    .map((i) => ({ path: i.path ?? '', message: i.message, code: i.code }));

/**
 * Merges one fork with its upstream's active version and records the result. Idempotent: the offer
 * must still be pending, the version id is a content hash, and every write is fenced on the fork
 * being where this read it.
 */
async function merge(ctx: ServiceContext, u: Offer): Promise<void> {
  const db = ctx.env.DB;
  const fork = await getForkRow(db, u.templateId);
  // A paused fork keeps its offer pending: resuming plans it again.
  if (fork?.tracking === 'paused') return;
  const [template, upstream, tip] = await Promise.all([
    getTemplate(db, u.templateId),
    getTemplate(db, u.upstreamId),
    forkTip(db, u.templateId),
  ]);
  const stale =
    !fork ||
    fork.upstream !== u.upstreamId ||
    fork.org !== u.orgId ||
    template?.status !== 'active' ||
    template.orgId !== u.orgId ||
    upstream?.origin !== 'baked' ||
    upstream.status !== 'active' ||
    upstream.activeVersion !== u.upstreamVersion ||
    tip?.version !== u.oursVersion;
  if (stale || !fork || !template || !upstream) {
    await failOffer(ctx, u, FORK_STALE);
    return;
  }
  if (!(await upstreamReadable(db, u.upstreamId))) {
    ctx.log.warn('templates.fork_update_detached', {
      code: 'TEMPLATE_FORK_UPSTREAM_UNREADABLE',
      templateId: u.templateId,
    });
    await failOffer(ctx, u, 'TEMPLATE_FORK_UPSTREAM_UNREADABLE');
    return;
  }
  const state = await readForkState(db, u.templateId);
  const [ours, theirs] = await Promise.all([
    getVersion(db, u.templateId, u.oursVersion),
    getVersion(db, u.upstreamId, u.upstreamVersion),
  ]);
  if (!ours || !theirs) {
    await failOffer(ctx, u, FORK_STALE);
    return;
  }
  const resolved = await resolveBase(
    ctx,
    {
      forkId: u.templateId,
      upstreamId: u.upstreamId,
      forkCreatedAt: fork.createdAt,
      upstreamVersion: u.upstreamVersion,
    },
    u.oursVersion,
  );
  const inferred = resolved.inferred ? resolved : null;
  const baseInfo = { version: resolved.upstreamVersion, inferred: resolved.inferred };
  const done = (outcome: Outcome) => settleOffer(ctx, u, state, outcome, inferred);
  // A fork with no history is not offered every difference as a clash: it adopts the current version.
  if (resolved.adopt)
    return finish(ctx, u, await done({ status: 'noop', summary: { base: baseInfo } }));

  const baseVersion = await getVersion(db, u.upstreamId, resolved.upstreamVersion);
  const [oursDoc, theirsDoc, baseDoc] = await Promise.all([
    docOf(ctx, ours),
    docOf(ctx, theirs),
    baseVersion ? docOf(ctx, baseVersion) : Promise.resolve(null),
  ]);
  let result: MergeResult = mergePackages(baseDoc, oursDoc, theirsDoc);
  let kept: MergeResult['conflicts'] = [];
  if (result.conflicts.length > 0) {
    const picks = keptYours(result.conflicts, await orgBrandingJson(db, u.orgId));
    kept = result.conflicts.filter((c) => c.id in picks);
    if (kept.length > 0) result = mergePackages(baseDoc, oursDoc, theirsDoc, { picks });
  }
  const summary = summaryOf(result, baseInfo, kept);
  if (result.conflicts.length > 0)
    return finish(
      ctx,
      u,
      await done({ status: 'conflicted', conflicts: result.conflicts, summary }),
    );
  if (sameDoc(result.merged, oursDoc))
    return finish(ctx, u, await done({ status: 'noop', summary }));

  let checked: Awaited<ReturnType<typeof checkVersion>>;
  try {
    checked = await checkVersion(
      ctx,
      { id: u.templateId, name: template.name },
      u.orgId,
      saveBody(result.merged, oursDoc, theirsDoc),
      imagesFromBinding(ctx.env.IMAGES, ctx.log),
      { dryRun: false },
      { upstreamId: u.upstreamId },
    );
  } catch (error) {
    if (!(error instanceof AppError) || !error.issues) throw error;
    const conflicts = invalidConflicts(error.issues);
    return finish(ctx, u, await done({ status: 'invalid', conflicts, summary }));
  }
  if ('refused' in checked) {
    const conflicts = invalidConflicts(refused(checked.refused.report.issues));
    return finish(ctx, u, await done({ status: 'invalid', conflicts, summary }));
  }
  const { analysis, report, carried } = checked;
  if (analysis.version === ours.version)
    return finish(ctx, u, await done({ status: 'noop', summary }));

  // Files not already the fork's own are copied under the fork: a version never points at the upstream's objects.
  const assets: AssetEntry[] = [];
  for (const a of analysis.assets) {
    const own = carried.get(a.name);
    if (own && own.sha1 === a.sha1) {
      assets.push({ ...a, source: own.source });
      continue;
    }
    const bytes = analysis.files.get(a.name);
    if (!bytes) throw new Error(`Missing file ${a.name}`);
    const key = r2Key(u.orgId, u.templateId, analysis.version, a.name);
    await putVersionAsset(ctx, key, bytes);
    assets.push({ ...a, source: { kind: 'r2', key } });
  }
  const digest = await templateContentDigest(ctx, {
    manifest: analysis.manifest,
    passJson: analysis.passJson,
    assets,
  });
  const hashes = { contentHash: digest.hash, assetHashes: digest.assetHashes };
  const saved = await getVersionHashes(db, u.templateId, analysis.version);
  if (saved && saved.contentHash !== hashes.contentHash)
    throw new ConflictError(
      'The merged version already has different content.',
      'TEMPLATE_CONTENT_CHANGED',
    );
  // Unreviewed edits ride in this version: their author must not be able to approve it.
  const createdBy = (await hasApproval(db, u.templateId, ours.version)) ? null : ours.createdBy;
  const outcome = await commitMerge(ctx, u, state, {
    version: {
      templateId: u.templateId,
      version: analysis.version,
      buildKey: await buildKey(analysis),
      manifest: analysis.manifest,
      passJson: analysis.passJson,
      assets,
      report,
      createdBy,
      createdAt: ctx.clock.now(),
    },
    hashes,
    modes: await releaseModes(db, u.templateId, u.orgId),
    summary,
    inferred,
  });
  await finish(ctx, u, outcome);
}

/** A write refused because the fork moved: the offer is failed, and the planner opens a fresh one. */
async function finish(ctx: ServiceContext, u: Offer, outcome: 'ok' | 'stale'): Promise<void> {
  if (outcome === 'ok') return;
  ctx.log.info('templates.fork_update_stale', { code: FORK_STALE, templateId: u.templateId });
  await failOffer(ctx, u, FORK_STALE);
}

export async function handleForkUpdate(
  job: JobOf<'template.fork_update'>,
  ctx: ServiceContext,
): Promise<void> {
  // Only the offer's id is taken from the message; everything else is what the database says.
  const offer = await getOffer(ctx.env.DB, job.updateId);
  if (offer?.status !== 'pending') return;
  if (offer.templateId !== job.templateId || offer.orgId !== job.orgId) {
    ctx.log.warn('templates.fork_update_mismatch', { code: 'TEMPLATE_FORK_UPDATE_MISMATCH' });
    return;
  }
  try {
    await merge(ctx, offer);
  } catch (error) {
    ctx.log.error('templates.fork_update_failed', {
      code: FAILED,
      updateId: offer.id,
      templateId: offer.templateId,
      error,
    });
    try {
      await failOffer(ctx, offer, FAILED);
    } catch (again) {
      ctx.log.error('templates.fork_update_failed', {
        code: FAILED,
        updateId: offer.id,
        error: again,
      });
    }
  }
}
