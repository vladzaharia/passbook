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
import { buildKey, canonicalJson } from './package/hash.ts';
import { r2Key, r2Prefix } from './registry.ts';
import { readReleaseAsset, templateContentDigest } from './release-content.ts';
import { getTemplate, getVersion } from './repo.ts';
import { FORK_STALE, readForkState } from './repo-fork-update-checks.ts';
import { type ForkRow, getForkRow, getOffer, type Offer, orgActive } from './repo-fork-updates.ts';
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
  // The fence state is read before the tip: a save in between makes the write refuse, never pass.
  const state = await readForkState(db, u.templateId);
  const fork = await getForkRow(db, u.templateId);
  // A paused fork, an archived template or a suspended org keeps its offer pending: the retry lane
  // (which skips them while they last) queues it again when they are back.
  if (fork?.tracking === 'paused' || !(await orgActive(db, u.orgId))) return;
  const template = await getTemplate(db, u.templateId);
  if (template?.status === 'archived') return;
  if (!fork || !template || (await moved(db, u, fork))) {
    await failOffer(ctx, u, FORK_STALE);
    return;
  }
  const upstream = await getTemplate(db, u.upstreamId);
  if (!upstream || !(await upstreamReadable(db, u.upstreamId, u.templateId))) {
    ctx.log.warn('templates.fork_update_detached', {
      code: 'TEMPLATE_FORK_UPSTREAM_UNREADABLE',
      templateId: u.templateId,
    });
    await failOffer(ctx, u, 'TEMPLATE_FORK_UPSTREAM_UNREADABLE');
    return;
  }
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

  // The fork is where the batch will expect it: no object is put for a merge that is already stale.
  // (An object of a merge that loses the fence afterwards is an orphan under the fork's own prefix.)
  if (JSON.stringify(await readForkState(db, u.templateId)) !== JSON.stringify(state)) return;
  // Files not already the fork's own are copied under the fork: a version never points at the upstream's objects.
  const assets: AssetEntry[] = [];
  const prefix = r2Prefix(u.orgId, u.templateId);
  for (const a of analysis.assets) {
    const carry = carried.get(a.name);
    const own =
      carry?.sha1 === a.sha1 && carry.source.kind === 'r2' && carry.source.key.startsWith(prefix);
    if (carry && own) {
      assets.push({ ...a, source: carry.source });
      continue;
    }
    // A strip carried from the upstream has no bytes in the analysis: read it, verified, to copy it.
    const bytes =
      analysis.files.get(a.name) ??
      (carry?.sha1 === a.sha1 ? await readReleaseAsset(ctx, { ...a, source: carry.source }) : null);
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
  // Unreviewed edits ride in this version: their author must not be able to approve it. Only a peer
  // approval counts as review; a Test or sole approval is the author's own. A version that already
  // exists keeps its author (a candidate must name it), so a reused id never changes the rule's answer.
  // Parity with a human save: one author is named, even when several wrote the unreviewed edits.
  const existing = await getVersion(db, u.templateId, analysis.version);
  const createdBy = existing
    ? existing.createdBy
    : (await hasApproval(db, u.templateId, ours.version))
      ? null
      : ours.createdBy;
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
  if (outcome === 'ok') {
    const stored = await getVersion(db, u.templateId, analysis.version);
    const shape = (v: { manifest: unknown; passJson: unknown; assets: unknown; report: unknown }) =>
      canonicalJson({
        m: v.manifest,
        p: v.passJson,
        a: (v.assets as AssetEntry[]).map(({ source: _s, ...rest }) => rest),
        r: v.report,
      });
    if (
      !stored ||
      shape(stored) !==
        shape({ manifest: analysis.manifest, passJson: analysis.passJson, assets, report })
    )
      throw new ConflictError(
        'The merged version has different content than stored.',
        'TEMPLATE_CONTENT_CHANGED',
      );
  }
  await finish(ctx, u, outcome);
}

/** The offer can never be answered: its fork, tip or upstream version is not the one it was made for. */
async function moved(db: D1Database, u: Offer, known?: ForkRow | null): Promise<boolean> {
  const fork = known ?? (await getForkRow(db, u.templateId));
  const [template, upstream, tip] = await Promise.all([
    getTemplate(db, u.templateId),
    getTemplate(db, u.upstreamId),
    forkTip(db, u.templateId),
  ]);
  return (
    !fork ||
    fork.upstream !== u.upstreamId ||
    fork.org !== u.orgId ||
    !template ||
    template.status === 'deleted' ||
    template.orgId !== u.orgId ||
    upstream?.origin !== 'baked' ||
    upstream.status !== 'active' ||
    upstream.activeVersion !== u.upstreamVersion ||
    tip?.version !== u.oursVersion
  );
}

/**
 * A write refused. If the fork, tip and upstream are still the ones the offer was made for, only
 * something a re-plan ignores moved (an approval elsewhere, a pause mid-job): the offer stays pending
 * and the retry lane tries again. Otherwise it is failed for good and the planner opens a fresh one.
 */
async function finish(ctx: ServiceContext, u: Offer, outcome: 'ok' | 'stale'): Promise<void> {
  if (outcome === 'ok') return;
  ctx.log.info('templates.fork_update_stale', { code: FORK_STALE, templateId: u.templateId });
  if (await moved(ctx.env.DB, u)) await failOffer(ctx, u, FORK_STALE);
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
