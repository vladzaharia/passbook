import { jobGrant } from '../../platform/authority.ts';
import { maxNow } from '../../platform/authority-expr.ts';
import { classifyD1Error } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { deliverPush } from '../delivery/push.ts';
import { requireCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { removePass } from '../passes/remove.ts';
import { deleteObjects, deletePassRows } from '../passes/repo-ops-retention.ts';
import { softDeletePass } from '../passes/repo-pass-trusted.ts';
import { pendingPushId } from '../passes/repo-read-pass.ts';
import { dropPrintPdfs } from '../prints/pdf-drop.ts';
import { writeReceipt } from '../retention/receipt-service.ts';
import { prepareScanRetentionDelete } from '../scan/scan-retention-proof.ts';
import { purgeOrgWalletArt } from '../wallet-providers/projection-art-purge.ts';
import { failOpenExports, lifecycleRow } from './repo.ts';
import { orgPrefixes, PASSES_AT, PURGE_STEPS, type PurgeStep } from './repo-plan.ts';
import { deleteGroup, deleteStep, orgPasses, remaining, uploadIds } from './repo-purge.ts';

export type PurgeStart = 'started' | 'resumed' | 'held' | 'not_due' | 'skipped' | 'done';

const PAGE = 50;
/** Devices get this long to fetch the voided pass before any row goes. */
export const GRACE_MS = 7 * 86_400_000;
const SYSTEM = { type: 'system', id: null } as const;
/** Receipt class of a purge, on the org's own chain. */
export const PURGE_RECEIPT_CLASS = 'org_purge';

/**
 * Marks the org as in purge, once its window is over and no hold stands. The trigger refuses the write
 * under a hold, so a hold placed between the read and the write still wins.
 */
export async function beginPurge(ctx: ServiceContext, orgId: string): Promise<PurgeStart> {
  const row = await lifecycleRow(ctx.env.DB, orgId);
  if (row?.status !== 'deleted' || row.purge_after === null) return 'skipped';
  if (row.purged_at !== null) return 'done';
  if (row.held) return 'held';
  if (row.purge_started_at !== null) {
    await failOpenExports(ctx.env.DB, orgId, ctx.clock.now());
    return 'resumed';
  }
  if (row.purge_after > ctx.clock.now()) return 'not_due';
  const g = jobGrant(ctx, {
    job: 'org-purge',
    purpose: 'platform.job.org.purge',
    target: orgId,
  });
  g.update('orgs', {
    set: { purge_started_at: ctx.clock.now(), updated_at: maxNow(ctx.clock.now()) },
    where: { id: orgId, status: 'deleted', purge_started_at: null },
    returning: ['id'],
  });
  try {
    const [result] = await g.commit();
    if ((result?.results.length ?? 0) === 0) return 'skipped';
    await failOpenExports(ctx.env.DB, orgId, ctx.clock.now());
    return 'started';
  } catch (error) {
    if (classifyD1Error(error)?.kind === 'abort') return 'held';
    throw error;
  }
}

/** The purge may go on: closed, started, not held, not finished. */
export async function stillPurging(ctx: ServiceContext, orgId: string): Promise<boolean> {
  const row = await lifecycleRow(ctx.env.DB, orgId);
  return (
    !!row &&
    row.status === 'deleted' &&
    row.purge_started_at !== null &&
    !row.held &&
    row.purged_at === null
  );
}

/**
 * Voids one page of the org's passes the way a removal does (a last voided, expired version) and pushes it, so
 * devices fetch it. Apple serves a closed org's voided passes only. `failed` counts passes that could not be
 * voided now; the purge does not go on until none is left.
 */
export async function voidPage(ctx: ServiceContext, orgId: string, after: string) {
  const passes = await orgPasses(ctx.env.DB, orgId, after, PAGE, true);
  let voided = 0;
  let failed = 0;
  for (const pass of passes) {
    if (pass.removedAt !== null && pass.status === 'voided') continue;
    try {
      await removePass(ctx, SYSTEM, pass.id, {}, null, undefined, undefined, true);
      const pushId = await pendingPushId(ctx.env.DB, pass.id);
      if (pushId) await deliverPush(ctx, pushId);
      voided++;
    } catch (error) {
      failed++;
      ctx.log.warn('org.purge_void_failed', {
        orgId,
        passId: pass.id,
        code: 'ORG_PURGE_VOID',
        error,
      });
    }
  }
  return { voided, failed, last: passes.at(-1)?.id ?? null, more: passes.length === PAGE };
}

/** Starts the grace period once every pass is voided. Returns when it ends. */
export async function markVoided(ctx: ServiceContext, orgId: string): Promise<number> {
  const row = await lifecycleRow(ctx.env.DB, orgId);
  if (row?.purge_voided_at) return row.purge_voided_at + GRACE_MS;
  const now = ctx.clock.now();
  const g = jobGrant(ctx, { job: 'org-purge', purpose: 'platform.job.org.purge', target: orgId });
  g.update('orgs', {
    set: { purge_voided_at: now, updated_at: maxNow(now) },
    where: { id: orgId, status: 'deleted', purge_voided_at: null },
    returning: ['id'],
  });
  await g.commit();
  const after = await lifecycleRow(ctx.env.DB, orgId);
  return (after?.purge_voided_at ?? now) + GRACE_MS;
}

/** Soft-deletes one page of passes, so Wallet providers start to retire them. */
export async function softDeletePage(ctx: ServiceContext, orgId: string, after: string) {
  const passes = await orgPasses(ctx.env.DB, orgId, after, PAGE, true);
  let done = 0;
  for (const pass of passes) if (await softDeletePass(ctx.env.DB, pass, ctx.clock.now())) done++;
  return { done, last: passes.at(-1)?.id ?? null, more: passes.length === PAGE };
}

/**
 * Removes one page of passes (rows, versions, files) that Wallet providers no longer hold. A pass under a
 * pending transfer or a legal hold stays; `left` counts what is still there after `after`.
 */
export async function deletePassesPage(ctx: ServiceContext, orgId: string, after: string) {
  if (!(await graceOver(ctx, orgId))) return { deleted: 0, last: null, more: false };
  const keyset = await requireCredentialRefKeyset(ctx.env.DB, ctx.env);
  const passes = await orgPasses(ctx.env.DB, orgId, after, PAGE, false);
  let deleted = 0;
  for (const pass of passes) {
    const retention = await prepareScanRetentionDelete(ctx.env, pass);
    const removed = await deletePassRows(ctx.env.DB, pass, retention, keyset);
    if (!removed.deleted) continue;
    await deleteObjects(ctx.env.BUCKET, removed.objectKeys);
    await dropPrintPdfs(ctx, pass);
    deleted++;
  }
  return { deleted, last: passes.at(-1)?.id ?? null, more: passes.length === PAGE };
}

/** Every pass was voided and the devices have had their grace period. */
export async function graceOver(ctx: ServiceContext, orgId: string): Promise<boolean> {
  const row = await lifecycleRow(ctx.env.DB, orgId);
  return row?.purge_voided_at != null && row.purge_voided_at + GRACE_MS <= ctx.clock.now();
}

/** Passes still in the org. */
export const passesLeft = (ctx: ServiceContext, orgId: string) =>
  remaining(ctx.env.DB, { table: 'passes', where: 'org_id = ?1' }, orgId);

export type Phase = { kind: 'rows'; name: string; steps: PurgeStep[] } | { kind: 'passes' };

/** The plan as workflow phases, in order; passes are their own phase (pages, then a wait for providers). */
export const phases = (): Phase[] =>
  PURGE_STEPS.map((s, i): Phase => {
    if (!Array.isArray(s) && (s as PurgeStep).table === PASSES_AT) return { kind: 'passes' };
    const steps = Array.isArray(s) ? [...(s as PurgeStep[])] : [s as PurgeStep];
    return { kind: 'rows', name: `${i}-${steps[0]?.table}`, steps };
  });

/** Runs one rows phase: a table in slices, or a group in one batch. Returns rows removed. */
export async function runRows(
  ctx: ServiceContext,
  orgId: string,
  steps: PurgeStep[],
): Promise<number> {
  const [only] = steps;
  const cutoff = ctx.clock.now() - GRACE_MS;
  if (steps.length === 1 && only) return deleteStep(ctx.env.DB, only, orgId, cutoff);
  return deleteGroup(ctx.env.DB, steps, orgId, cutoff);
}

/** What the purge has not removed yet: tables with rows, and org prefixes in R2 with objects. */
export async function leftovers(ctx: ServiceContext, orgId: string): Promise<string[]> {
  const out: string[] = [];
  for (const s of PURGE_STEPS)
    for (const step of Array.isArray(s) ? s : [s as PurgeStep])
      if ((await remaining(ctx.env.DB, step, orgId)) > 0) out.push(step.table);
  for (const prefix of orgPrefixes(orgId))
    if ((await ctx.env.BUCKET.list({ prefix, limit: 1 })).objects.length > 0)
      out.push(`r2:${prefix}`);
  return out;
}

async function deletePrefix(ctx: ServiceContext, prefix: string): Promise<number> {
  let removed = 0;
  let cursor: string | undefined;
  do {
    const page = await ctx.env.BUCKET.list({ prefix, ...(cursor ? { cursor } : {}), limit: 500 });
    if (page.objects.length > 0) {
      await ctx.env.BUCKET.delete(page.objects.map((o) => o.key));
      removed += page.objects.length;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return removed;
}

/** Staged template uploads are keyed by upload id, so they go before the rows that name them. */
export async function purgeUploads(ctx: ServiceContext, orgId: string): Promise<number> {
  let removed = 0;
  for (const id of await uploadIds(ctx.env.DB, orgId)) {
    await ctx.env.BUCKET.delete(`uploads/${id}.zip`);
    removed += await deletePrefix(ctx, `uploads/${id}/`);
  }
  return removed;
}

/** Org-prefixed files in R2. A hold placed meanwhile stops it before the next prefix. */
export async function purgeFiles(ctx: ServiceContext, orgId: string): Promise<number> {
  let removed = 0;
  for (const prefix of orgPrefixes(orgId)) {
    if (!(await stillPurging(ctx, orgId))) return removed;
    removed += await deletePrefix(ctx, prefix);
  }
  await purgeOrgWalletArt(ctx, orgId);
  return removed;
}

/**
 * The stub, then the receipt and the audit row, by whichever run claims the stub first: a repeat or a parallel
 * run finds it claimed and writes nothing.
 */
export async function finishPurge(
  ctx: ServiceContext,
  orgId: string,
  deleted: number,
): Promise<boolean> {
  const row = await lifecycleRow(ctx.env.DB, orgId);
  if (!row || row.purged_at !== null || !(await stillPurging(ctx, orgId))) return false;
  const now = ctx.clock.now();
  const g = jobGrant(ctx, { job: 'org-purge', purpose: 'platform.job.org.purge', target: orgId });
  g.update('orgs', {
    set: { name: 'Closed organization', branding: '{}', purged_at: now, updated_at: maxNow(now) },
    where: { id: orgId, status: 'deleted', purged_at: null },
    returning: ['id'],
  });
  const [result] = await g.commit();
  if ((result?.results.length ?? 0) === 0) return false;
  await writeReceipt(ctx, {
    orgId,
    cls: PURGE_RECEIPT_CLASS,
    kind: 'sweep',
    cutoffAt: row.purge_after,
    deleted,
  });
  await recordAudit(ctx, {
    orgId,
    actorType: 'system',
    actorId: null,
    action: 'org.purge',
    targetType: 'org',
    targetId: orgId,
    detail: { deleted },
  });
  return true;
}

/** Why `finishPurge` did nothing: another run finished it, a hold stands, or something else. */
export async function endState(
  ctx: ServiceContext,
  orgId: string,
): Promise<'done' | 'held' | 'incomplete'> {
  const row = await lifecycleRow(ctx.env.DB, orgId);
  if (row?.purged_at != null) return 'done';
  return row?.held ? 'held' : 'incomplete';
}
