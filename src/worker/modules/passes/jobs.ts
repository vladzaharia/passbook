import type { ServiceContext } from '../../platform/service-context.ts';
import { prepareScanRetentionDelete } from '../scan/scan-retention-proof.ts';
import { getPlatformSettings } from '../settings/service.ts';
import { requireCredentialRefKeyset } from './credential-keyset.ts';
import { deleteIdempotencyBefore, markPurged, versionsToPurge } from './repo.ts';
import {
  blockedDeletedPasses,
  deleteObjects,
  deletePassRows,
  expiredDeletedPasses,
} from './repo-ops-retention.ts';

const DAY = 86_400_000;
const PURGE_BATCH = 500;
const MAX_PURGE_ROUNDS = 20;
/** Deleted passes stay served (voided) to registered devices for this long. */
const DELETE_GRACE_MS = 7 * DAY;
const DELETE_BATCH = 50;

async function purge(ctx: ServiceContext): Promise<number> {
  const settings = await getPlatformSettings(ctx);
  const keep = settings['retention.passVersionsKeep'];
  let total = 0;
  for (let round = 0; round < MAX_PURGE_ROUNDS; round++) {
    const rows = await versionsToPurge(ctx.env.DB, keep, PURGE_BATCH);
    if (rows.length === 0) break;
    const keys = rows.flatMap((r) => (r.objectKey ? [r.objectKey] : []));
    await deleteObjects(ctx.env.BUCKET, keys);
    await markPurged(ctx.env.DB, rows, ctx.clock.now());
    total += rows.length;
    if (rows.length < PURGE_BATCH) break;
  }
  return total;
}

/** Hard-deletes soft-deleted passes (rows and R2 objects) once the grace period has passed. */
async function purgeDeletedPasses(
  ctx: ServiceContext,
  credentialKeysetCommitment: string,
): Promise<number> {
  let total = 0;
  const before = ctx.clock.now() - DELETE_GRACE_MS;
  // A cursor, not a re-query: a pass that stays (a lost race) cannot be selected again this run.
  let after = '';
  for (let round = 0; round < MAX_PURGE_ROUNDS; round++) {
    const passes = await expiredDeletedPasses(ctx.env.DB, before, after, DELETE_BATCH);
    after = passes.at(-1)?.id ?? after;
    for (const pass of passes) {
      const retention = await prepareScanRetentionDelete(ctx.env, pass);
      const removed = await deletePassRows(ctx.env.DB, pass, retention, credentialKeysetCommitment);
      await deleteObjects(ctx.env.BUCKET, removed.objectKeys);
      if (removed.deleted) total += 1;
    }
    if (passes.length < DELETE_BATCH) break;
  }
  const blocked = await blockedDeletedPasses(ctx.env.DB, before, 20);
  if (blocked.length > 0)
    ctx.log.warn('passes.purge_blocked', {
      code: 'PASS_PURGE_BLOCKED',
      count: blocked.length,
      passIds: blocked.map((b) => b.id),
    });
  return total;
}

/**
 * Keeps the current version plus the last N (setting), drops idempotency keys after 7 days and
 * removes passes deleted more than 7 days ago.
 * The credential keyset is required before any cleanup and remains pinned through deletion.
 */
export async function dailyPasses(ctx: ServiceContext): Promise<void> {
  const credentialKeysetCommitment = await requireCredentialRefKeyset(ctx.env.DB, ctx.env);
  const purged = await purge(ctx);
  const keys = await deleteIdempotencyBefore(ctx.env.DB, ctx.clock.now() - 7 * DAY);
  const deleted = await purgeDeletedPasses(ctx, credentialKeysetCommitment);
  ctx.log.info('passes.retention', { purged, idempotencyKeys: keys, deletedPasses: deleted });
}
