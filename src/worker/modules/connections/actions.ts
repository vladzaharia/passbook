import type { z } from 'zod';
import type {
  ConnectionRunsQuerySchema,
  ConnectionsSummarySchema,
  SyncNowResponseSchema,
  TestConnectionResponseSchema,
} from '../../../shared/contracts/index.ts';
import type { Actor } from '../../platform/context.ts';
import { ConflictError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { toDto } from './dto.ts';
import { patchConnection, summary } from './repo.ts';
import { finishRun, insertRun, listRuns } from './repo-runs.ts';
import { classify, prepare } from './runtime.ts';
import { adminInstanceId, startSync } from './schedule.ts';
import { dropCredentials, newWebhookSecret, storeCredential } from './secrets.ts';
import { auditActor, requireConnection } from './service.ts';
import { assertModeSupported, requireConnector } from './validate.ts';

/** Calls the connector's test(). Writes a 'test' run; never changes health or passes. */
export async function test(
  sctx: ServiceContext,
  actor: Actor,
  id: string,
): Promise<z.infer<typeof TestConnectionResponseSchema>> {
  const conn = await requireConnection(sctx, id);
  const runId = sctx.ids.id();
  const startedAt = sctx.clock.now();
  await insertRun(sctx.env.DB, {
    id: runId,
    connectionId: id,
    trigger: 'test',
    actorId: actor.id,
    startedAt,
  });
  let result: z.infer<typeof TestConnectionResponseSchema>;
  let httpStatus: number | null = null;
  try {
    const prep = await prepare(sctx, conn);
    const outcome = (await prep.def.test?.(prep.cc)) ?? {
      ok: true as const,
      detail: 'No test available.',
    };
    result = {
      ok: true,
      ...(outcome.detail ? { detail: outcome.detail } : {}),
      durationMs: sctx.clock.now() - startedAt,
    };
  } catch (error) {
    const failure = classify(error);
    httpStatus = failure.httpStatus;
    if (failure.code === 'INTERNAL')
      sctx.log.error('connection.test_failed', { connectionId: id, error });
    result = { ok: false, errorCode: failure.code, durationMs: sctx.clock.now() - startedAt };
  }
  const finishedAt = sctx.clock.now();
  await finishRun(sctx.env.DB, {
    id: runId,
    finishedAt,
    outcome: result.ok ? 'unchanged' : 'error',
    recordsSeen: 0,
    passesChanged: 0,
    errorCode: result.errorCode ?? null,
    errorDetail: null,
    httpStatus,
  });
  await recordAudit(sctx, {
    orgId: conn.orgId,
    ...auditActor(actor),
    action: 'connection.test',
    targetType: 'connection',
    targetId: id,
    detail: { ok: result.ok, errorCode: result.errorCode ?? null },
  });
  return result;
}

export async function syncNow(
  sctx: ServiceContext,
  actor: Actor,
  id: string,
): Promise<z.infer<typeof SyncNowResponseSchema>> {
  const conn = await requireConnection(sctx, id);
  if (!conn.enabled) throw new ConflictError('The connection is disabled.', 'CONNECTION_DISABLED');
  const instanceId = adminInstanceId(id, sctx.clock.now());
  const started = await startSync(sctx, conn, 'admin', instanceId, actor.id);
  await recordAudit(sctx, {
    orgId: conn.orgId,
    ...auditActor(actor),
    action: 'connection.sync',
    targetType: 'connection',
    targetId: id,
  });
  return started;
}

/** Replaces the webhook secret and returns the new value once. */
export async function rotateWebhookSecret(
  sctx: ServiceContext,
  actor: Actor,
  id: string,
): Promise<{ webhookSecret: string; connection: ReturnType<typeof toDto> }> {
  const conn = await requireConnection(sctx, id);
  const def = requireConnector(conn.connectorType);
  assertModeSupported(def, conn.mode === 'poll' || conn.mode === 'manual' ? 'webhook' : conn.mode);
  const secret = newWebhookSecret(sctx);
  const credentialId = await storeCredential(sctx, {
    orgId: conn.orgId,
    kind: 'webhook',
    value: secret,
    createdBy: actor.id,
  });
  await patchConnection(sctx.env.DB, id, {
    webhookCredentialId: credentialId,
    updatedAt: sctx.clock.now(),
  });
  await dropCredentials(sctx, [conn.webhookCredentialId]);
  await recordAudit(sctx, {
    orgId: conn.orgId,
    ...auditActor(actor),
    action: 'connection.webhook_secret',
    targetType: 'connection',
    targetId: id,
  });
  return { webhookSecret: secret, connection: toDto(sctx.env, await requireConnection(sctx, id)) };
}

export async function runs(
  sctx: ServiceContext,
  id: string,
  query: z.infer<typeof ConnectionRunsQuerySchema>,
) {
  await requireConnection(sctx, id);
  const rows = await listRuns(sctx.env.DB, id, { cursor: query.cursor, limit: query.limit + 1 });
  const page = rows.slice(0, query.limit);
  return { items: page, nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null };
}

export async function healthSummary(
  sctx: ServiceContext,
): Promise<z.infer<typeof ConnectionsSummarySchema>> {
  const { counts, attention } = await summary(sctx.env.DB);
  return {
    total: counts.reduce((n, c) => n + c.n, 0),
    byHealth: Object.fromEntries(counts.map((c) => [c.health, c.n])),
    attention: attention.map((a) => ({
      id: a.id,
      orgId: a.org_id,
      name: a.name,
      health: a.health,
      lastErrorCode: a.last_error_code,
      lastErrorAt: a.last_error_at,
    })),
  };
}
