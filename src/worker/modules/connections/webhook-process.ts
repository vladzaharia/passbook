import { connectors } from '../../connectors/registry.ts';
import type { UpstreamRecord } from '../../connectors/types.ts';
import type { JobOf } from '../../jobs/types.ts';
import { UnavailableError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { isOrgActive } from '../orgs/active.ts';
import { closeRun } from './health.ts';
import { captureConnectionRelease, emptyTotals } from './records.ts';
import { getConnection } from './repo.ts';
import { insertRun } from './repo-runs.ts';
import { classify, type Prepared, prepare } from './runtime.ts';
import { applyChanges } from './sync-apply.ts';
import { webhookItemObserver } from './webhook-item-observer.ts';
import { pinWebhookKeyContext } from './webhook-key-context.ts';
import { failUnprovenLegacyWebhook } from './webhook-legacy-unproven.ts';
import {
  failRetainedWebhook,
  ignoreRetainedWebhook,
  type LoadedRetainedWebhook,
  loadRetainedWebhook,
  resolveRetainedWebhook,
} from './webhook-retention.ts';
import { summarizeRetainedWebhookItems } from './webhook-retention-items.ts';

/** Recheck the actual connection, not just pass-level races reported by applyChanges. */
async function webhookConnectionCurrent(
  sctx: ServiceContext,
  job: JobOf<'connection.webhook'>,
  mode: 'webhook' | 'hybrid',
): Promise<boolean> {
  const conn = await getConnection(sctx.env.DB, job.connectionId);
  return (
    !!conn?.enabled &&
    conn.orgId === job.orgId &&
    conn.generation === job.generation &&
    conn.mode === mode &&
    (await isOrgActive(sctx, job.orgId))
  );
}

/** Applies one encrypted chunk using its original connection and release snapshots. */
export async function processWebhook(
  sctx: ServiceContext,
  job: JobOf<'connection.webhook'>,
): Promise<void> {
  sctx = pinWebhookKeyContext(sctx);
  const conn = await getConnection(sctx.env.DB, job.connectionId);
  if (!job.orgId || !Number.isInteger(job.generation) || job.generation < 1) {
    sctx.log.info('connection.webhook_stale', { connectionId: job.connectionId });
    return;
  }
  if (
    !conn?.enabled ||
    (conn.mode !== 'webhook' && conn.mode !== 'hybrid') ||
    conn.orgId !== job.orgId ||
    conn.generation !== job.generation ||
    !(await isOrgActive(sctx, job.orgId))
  ) {
    await ignoreRetainedWebhook(sctx, job, 'WEBHOOK_STALE_CONTEXT');
    sctx.log.info('connection.webhook_stale', { connectionId: job.connectionId });
    return;
  }

  let retained: LoadedRetainedWebhook | null;
  try {
    retained = await loadRetainedWebhook(sctx, job);
    // Baseline-shaped jobs never reach here (the queue retains them as ignored), so a missing
    // chunk is always a lost payload.
    if (!retained) {
      throw new UnavailableError('The webhook payload is unavailable.', 'WEBHOOK_PAYLOAD_MISSING');
    }
  } catch (error) {
    if (!(await webhookConnectionCurrent(sctx, job, conn.mode))) {
      await ignoreRetainedWebhook(sctx, job, 'WEBHOOK_STALE_CONTEXT');
      return;
    }
    throw error;
  }
  if (!retained.credentialKeysetCommitment) {
    if (retained.source === 'legacy') {
      await failUnprovenLegacyWebhook(sctx, job, retained.revision);
      return;
    }
    throw new UnavailableError(
      'The webhook credential context is unavailable.',
      'CREDENTIAL_REF_KEYSET_UNAVAILABLE',
    );
  }
  if (retained.state !== 'pending') return;
  const credentialKeysetCommitment = retained.credentialKeysetCommitment;
  const mode = retained.connectionMode;
  const revision = retained.revision;
  if (mode === 'unknown') {
    await failRetainedWebhook(sctx, job, 'WEBHOOK_MODE_UNKNOWN', revision);
    return;
  }
  if (mode !== conn.mode) {
    await ignoreRetainedWebhook(sctx, job, 'WEBHOOK_STALE_CONTEXT', revision);
    return;
  }
  const definition = connectors.get(conn.connectorType);
  if (!definition?.verifyWebhook || definition.webhookReferenceMode !== retained.referenceMode) {
    await failRetainedWebhook(sctx, job, 'WEBHOOK_REFERENCE_MODE_CHANGED', revision);
    return;
  }

  const runId = sctx.ids.id();
  const startedAt = sctx.clock.now();
  const inserted = await insertRun(
    sctx,
    {
      id: runId,
      connectionId: conn.id,
      trigger: 'webhook',
      startedAt,
      expected: { orgId: job.orgId, generation: job.generation, mode, credentialKeysetCommitment },
    },
    { orgId: job.orgId },
  );
  if (!inserted) {
    if (!(await webhookConnectionCurrent(sctx, job, mode))) {
      await ignoreRetainedWebhook(sctx, job, 'WEBHOOK_STALE_CONTEXT', revision);
      sctx.log.info('connection.webhook_stale', { connectionId: job.connectionId });
      return;
    }
    throw new UnavailableError('Webhook processing could not start.', 'WEBHOOK_UNAVAILABLE');
  }
  const base = {
    source: 'webhook' as const,
    runId,
    instanceId: null,
    orgId: job.orgId,
    generation: job.generation,
    connectionMode: mode,
    startedAt,
    credentialKeysetCommitment,
    stale: false,
    staleCode: 'STALE_CONTEXT' as const,
  };
  // Comparing is not adoption: work always uses its stored snapshot, or a local block
  // when that approved release was already superseded before this attempt.
  let release = retained.release;
  if (release?.kind === 'approved') {
    try {
      const current = await captureConnectionRelease(sctx, conn);
      if (
        current?.kind !== 'approved' ||
        current.id !== release.id ||
        current.generation !== release.generation ||
        current.version !== release.version
      ) {
        release = { kind: 'blocked', code: 'TEMPLATE_RELEASE_CONFLICT' };
      }
    } catch (error) {
      const failure = classify(error);
      await closeRun(
        sctx,
        conn.id,
        { ...base, totals: emptyTotals(), failure },
        { countsForBreaker: true, reschedule: false },
      );
      if (!(await webhookConnectionCurrent(sctx, job, mode))) {
        await ignoreRetainedWebhook(sctx, job, 'WEBHOOK_STALE_CONTEXT', revision);
        return;
      }
      throw new UnavailableError('Webhook processing failed.', `WEBHOOK_${failure.code}`);
    }
  }
  let prep: Prepared;
  try {
    prep = await prepare(sctx, conn);
  } catch (error) {
    const failure = classify(error);
    await closeRun(
      sctx,
      conn.id,
      { ...base, totals: emptyTotals(), failure },
      { countsForBreaker: true, reschedule: false },
    );
    if (!(await webhookConnectionCurrent(sctx, job, mode))) {
      await ignoreRetainedWebhook(sctx, job, 'WEBHOOK_STALE_CONTEXT', revision);
      return;
    }
    if (failure.code === 'AUTH' || failure.code === 'CONFIG') {
      await failRetainedWebhook(sctx, job, failure.code, revision);
      return;
    }
    throw new UnavailableError('Webhook processing failed.', `WEBHOOK_${failure.code}`);
  }
  const changes = retained.items.map((item) => ({
    ref: item.ref,
    deleted: item.deleted,
    record: (item.record ?? undefined) as UpstreamRecord | undefined,
  }));
  const applied = await applyChanges(
    sctx,
    conn,
    prep,
    changes,
    release,
    webhookItemObserver(sctx, job, revision, credentialKeysetCommitment),
    credentialKeysetCommitment,
  ).catch(async (error) => {
    const failure = classify(error);
    await closeRun(
      sctx,
      conn.id,
      { ...base, totals: emptyTotals(), failure },
      { countsForBreaker: false, reschedule: false },
    );
    if (!(await webhookConnectionCurrent(sctx, job, mode))) {
      await ignoreRetainedWebhook(sctx, job, 'WEBHOOK_STALE_CONTEXT', revision);
      return null;
    }
    throw new UnavailableError('Webhook processing failed.', `WEBHOOK_${failure.code}`);
  });
  if (!applied) return;
  const summary = await summarizeRetainedWebhookItems(sctx, job, revision);
  const blockedCode =
    summary.blockedCode === 'TEMPLATE_RELEASE_REQUIRED' ||
    summary.blockedCode === 'TEMPLATE_RELEASE_CONFLICT'
      ? summary.blockedCode
      : undefined;
  if (summary.blocked > 0 && !blockedCode) {
    throw new UnavailableError(
      'Webhook retention is unavailable.',
      'WEBHOOK_RETENTION_UNAVAILABLE',
    );
  }
  const { totals, failure, stale } = applied;
  const releaseBlocked = applied.releaseBlocked ?? blockedCode;
  const runFailure =
    failure ??
    (summary.uncertain > 0 && !releaseBlocked
      ? { code: 'INTERNAL' as const, httpStatus: null, retryAfterMs: null }
      : null);
  const closedStale = await closeRun(
    sctx,
    conn.id,
    {
      ...base,
      totals,
      failure: runFailure,
      stale: stale && summary.uncertain === 0,
      ...(stale ? { staleCode: 'STALE_CONTEXT' as const } : {}),
      ...(releaseBlocked ? { releaseBlocked } : {}),
    },
    {
      countsForBreaker: !!failure || !!releaseBlocked || summary.uncertain === 0,
      reschedule: false,
    },
  );
  if (!(await webhookConnectionCurrent(sctx, job, mode))) {
    await ignoreRetainedWebhook(sctx, job, 'WEBHOOK_STALE_CONTEXT', revision);
    return;
  }
  if (summary.started > 0) {
    throw new UnavailableError('Webhook processing needs to be retried.', 'WEBHOOK_ITEM_BUSY');
  }
  if (summary.pending > 0) {
    if (failure && (failure.code === 'AUTH' || failure.code === 'CONFIG')) {
      await failRetainedWebhook(sctx, job, failure.code, revision);
      return;
    }
    throw new UnavailableError(
      'Webhook processing needs to be retried.',
      failure ? `WEBHOOK_${failure.code}` : 'WEBHOOK_ITEM_PENDING',
    );
  }
  if (summary.failed > 0) {
    const code =
      summary.failedCode === 'WEBHOOK_RELEASE_STALE' ? 'WEBHOOK_RELEASE_STALE' : 'RECORD_ERRORS';
    await failRetainedWebhook(sctx, job, code, revision);
    return;
  }
  if (blockedCode) {
    await failRetainedWebhook(sctx, job, blockedCode, revision);
    return;
  }
  if (summary.uncertain > 0) {
    await failRetainedWebhook(sctx, job, 'WEBHOOK_EFFECT_UNCERTAIN', revision);
    return;
  }
  if (stale || closedStale) {
    throw new UnavailableError('Webhook processing needs to be retried.', 'WEBHOOK_STALE_CONTEXT');
  }
  if (failure) {
    if (failure.code === 'AUTH' || failure.code === 'CONFIG') {
      await failRetainedWebhook(sctx, job, failure.code, revision);
      return;
    }
    throw new UnavailableError('Webhook processing failed.', `WEBHOOK_${failure.code}`);
  }
  if (totals.errors > 0) {
    await failRetainedWebhook(sctx, job, 'RECORD_ERRORS', revision);
    return;
  }
  await resolveRetainedWebhook(sctx, job, revision);
}
