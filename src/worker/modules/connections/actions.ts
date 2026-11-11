import type { z } from 'zod';
import type {
  ConnectionRunsQuerySchema,
  ConnectionsSummarySchema,
  SyncNowResponseSchema,
  TestConnectionResponseSchema,
} from '../../../shared/contracts/index.ts';
import type { Actor } from '../../platform/context.ts';
import { ConflictError, ForbiddenError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { isOrgActive } from '../orgs/active.ts';
import { assertConnectionAuthority, type ConnectionAuthority } from './access.ts';
import { toDto } from './dto.ts';
import { patchConnection } from './repo.ts';
import { recordTestRun } from './repo-run-test.ts';
import { listRuns } from './repo-runs.ts';
import { summary } from './repo-stats.ts';
import { classify, prepare } from './runtime.ts';
import { adminBucketMs, adminInstanceId, startSync } from './schedule.ts';
import { dropCredentials, newWebhookSecret, storeCredential } from './secrets.ts';
import { auditActor, requireConnection } from './service.ts';
import { firstRecord, sampleFields } from './test-config.ts';
import { assertModeSupported, requireConnector } from './validate.ts';

/** Calls the connector's test(). Writes one finished 'test' run; never changes health or passes. */
export async function test(
  sctx: ServiceContext,
  actor: Actor,
  id: string,
  authority?: ConnectionAuthority,
): Promise<z.infer<typeof TestConnectionResponseSchema>> {
  const conn = await requireConnection(sctx, id);
  if (authority && authority.orgId !== conn.orgId) throw new ForbiddenError();
  const runId = sctx.ids.id();
  const startedAt = sctx.clock.now();
  const writer = { orgId: conn.orgId, authority };
  await assertConnectionAuthority(sctx, authority);
  let result: z.infer<typeof TestConnectionResponseSchema>;
  let httpStatus: number | null = null;
  try {
    await assertConnectionAuthority(sctx, authority);
    const prep = await prepare(sctx, conn);
    await assertConnectionAuthority(sctx, authority);
    const outcome = (await prep.def.test?.(prep.cc)) ?? {
      ok: true as const,
      detail: 'No test available.',
    };
    await assertConnectionAuthority(sctx, authority);
    const record = await firstRecord(prep.def, prep.cc);
    result = {
      ok: true,
      ...(outcome.detail ? { detail: outcome.detail } : {}),
      durationMs: sctx.clock.now() - startedAt,
      ...(record ? { sample: sampleFields(record) } : {}),
    };
  } catch (error) {
    await assertConnectionAuthority(sctx, authority);
    const failure = classify(error);
    httpStatus = failure.httpStatus;
    if (failure.code === 'INTERNAL')
      sctx.log.error('connection.test_failed', { connectionId: id, code: failure.code });
    result = { ok: false, errorCode: failure.code, durationMs: sctx.clock.now() - startedAt };
  }
  const recorded = await recordTestRun(
    sctx,
    {
      id: runId,
      connectionId: id,
      generation: conn.generation,
      actorId: actor.id,
      startedAt,
      finishedAt: sctx.clock.now(),
      outcome: result.ok ? 'unchanged' : 'error',
      errorCode: result.errorCode ?? null,
      httpStatus,
    },
    writer,
  );
  if (!recorded)
    throw new ConflictError('The connection changed. Reload and retry.', 'CONNECTION_CONFLICT');
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
  authority?: ConnectionAuthority,
): Promise<z.infer<typeof SyncNowResponseSchema>> {
  const conn = await requireConnection(sctx, id);
  if (authority && authority.orgId !== conn.orgId) throw new ForbiddenError();
  if (!conn.enabled) throw new ConflictError('The connection is disabled.', 'CONNECTION_DISABLED');
  if (!(await isOrgActive(sctx, conn.orgId))) {
    throw new ConflictError('The organization is not active.', 'ORG_INACTIVE');
  }
  const instanceId = await adminInstanceId(conn, sctx.clock.now(), adminBucketMs(sctx.env));
  const started = await startSync(sctx, conn, 'admin', instanceId, actor.id, authority);
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
  authority?: ConnectionAuthority,
): Promise<{ webhookSecret: string; connection: ReturnType<typeof toDto> }> {
  const conn = await requireConnection(sctx, id);
  if (authority && authority.orgId !== conn.orgId) throw new ForbiddenError();
  const def = requireConnector(conn.connectorType);
  assertModeSupported(def, conn.mode === 'poll' || conn.mode === 'manual' ? 'webhook' : conn.mode);
  const secret = newWebhookSecret(sctx);
  const credentialId = await storeCredential(
    sctx,
    {
      orgId: conn.orgId,
      kind: 'webhook',
      value: secret,
      createdBy: actor.type === 'user' ? actor.id : null,
    },
    authority,
  );
  let updated: number;
  try {
    updated = await patchConnection(
      sctx,
      id,
      { webhookCredentialId: credentialId, updatedAt: sctx.clock.now() },
      { actor: { orgId: conn.orgId, authority }, generation: conn.generation },
    );
    if (!updated) {
      throw new ConflictError('The connection changed. Reload and retry.', 'CONNECTION_CONFLICT');
    }
  } catch (error) {
    await dropCredentials(sctx, [credentialId, conn.webhookCredentialId]);
    throw error;
  }
  await dropCredentials(sctx, [conn.webhookCredentialId]);
  await recordAudit(sctx, {
    orgId: conn.orgId,
    ...auditActor(actor),
    action: 'connection.webhook_secret',
    targetType: 'connection',
    targetId: id,
  });
  const current = await requireConnection(sctx, id);
  if (authority && current.orgId !== conn.orgId) throw new ForbiddenError();
  return { webhookSecret: secret, connection: toDto(sctx.env, current) };
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
  orgId: string,
): Promise<z.infer<typeof ConnectionsSummarySchema>> {
  const { counts, attention } = await summary(sctx.env.DB, orgId);
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
