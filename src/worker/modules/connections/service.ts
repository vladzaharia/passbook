import type { z } from 'zod';
import type {
  ConnectionDetailSchema,
  ConnectionListQuerySchema,
} from '../../../shared/contracts/index.ts';
import type { Actor } from '../../platform/context.ts';
import { ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { connectorInfo, percentile, toDto } from './dto.ts';
import { schedules } from './health.ts';
import { validateMapping } from './mapping.ts';
import { type ConnectionRow, deleteConnection, insertConnection, listConnections } from './repo.ts';
import { passCountsFor } from './repo-passes.ts';
import { listRuns, runStats } from './repo-runs.ts';
import { dropCredentials, newWebhookSecret, storeCredential } from './secrets.ts';
import {
  auditActor,
  type Created,
  type CreateInput,
  requireConnection,
  secretsFor,
} from './service-shared.ts';
import {
  assertModeSupported,
  assertOrg,
  assertPointer,
  assertSafeUrls,
  assertTemplateUsable,
  parseWith,
  requireConnector,
} from './validate.ts';

export async function listAll(
  sctx: ServiceContext,
  query: z.infer<typeof ConnectionListQuerySchema>,
) {
  const rows = await listConnections(sctx.env.DB, {
    orgId: query.orgId,
    health: query.health,
    q: query.q,
    cursor: query.cursor,
    limit: query.limit + 1,
  });
  const page = rows.slice(0, query.limit);
  const counts = await passCountsFor(
    sctx.env.DB,
    page.map((r) => r.id),
  );
  return {
    items: page.map((r) => ({ ...toDto(sctx.env, r), passCount: counts.get(r.id) ?? 0 })),
    nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
  };
}

export async function getDetail(
  sctx: ServiceContext,
  id: string,
): Promise<z.infer<typeof ConnectionDetailSchema>> {
  const conn = await requireConnection(sctx, id);
  const runs = await listRuns(sctx.env.DB, id, { limit: 20 });
  const stats = await runStats(sctx.env.DB, id);
  const durations = stats.rows
    .flatMap((r) => (r.duration_ms === null ? [] : [r.duration_ms]))
    .sort((a, b) => a - b);
  const errors = stats.rows.filter((r) => r.outcome === 'error').length;
  return {
    ...toDto(sctx.env, conn),
    runs,
    metrics: {
      p50Ms: percentile(durations, 0.5),
      p95Ms: percentile(durations, 0.95),
      errorRate: stats.rows.length ? errors / stats.rows.length : null,
      passCount: stats.passCount,
    },
  };
}

export async function create(
  sctx: ServiceContext,
  actor: Actor,
  input: CreateInput,
): Promise<Created> {
  const def = requireConnector(input.connectorType);
  await assertOrg(sctx, input.orgId);
  const config = parseWith(def.configSchema, input.config, 'config');
  const mode =
    input.mode ??
    (def.capabilities.poll ? 'poll' : def.capabilities.webhook ? 'webhook' : 'manual');
  assertModeSupported(def, mode);
  validateMapping(input.mapping);
  assertPointer(input.holderEmailField, 'holderEmailField');
  if (input.defaultTemplateId)
    await assertTemplateUsable(sctx, input.orgId, input.defaultTemplateId);
  if (input.autoCreate && !input.defaultTemplateId) {
    throw new ValidationError('Auto-create needs a default template.', [
      { path: 'defaultTemplateId', message: 'Required with autoCreate.' },
    ]);
  }
  if (input.webhookSecret && !def.capabilities.webhook) {
    throw new ValidationError('This connector takes no webhooks.', [
      { path: 'webhookSecret', message: 'Not supported.' },
    ]);
  }
  await assertSafeUrls(sctx, def.urls?.(config) ?? []);
  const secretsJson = input.secrets ? secretsFor(def, input.secrets) : null;

  const now = sctx.clock.now();
  const id = sctx.ids.id();
  const wantsWebhook = mode === 'webhook' || mode === 'hybrid';
  const webhookSecret =
    wantsWebhook || input.webhookSecret ? (input.webhookSecret ?? newWebhookSecret(sctx)) : null;
  const credentialId =
    secretsJson && secretsJson !== '{}'
      ? await storeCredential(sctx, {
          orgId: input.orgId,
          kind: 'connector',
          value: secretsJson,
          createdBy: actor.id,
        })
      : null;
  const webhookCredentialId = webhookSecret
    ? await storeCredential(sctx, {
        orgId: input.orgId,
        kind: 'webhook',
        value: webhookSecret,
        createdBy: actor.id,
      })
    : null;

  const row: ConnectionRow = {
    id,
    orgId: input.orgId,
    connectorType: def.type,
    connectorVersion: def.version,
    name: input.name,
    config: config as ConnectionRow['config'],
    credentialId,
    webhookCredentialId,
    mapping: input.mapping ?? null,
    defaultTemplateId: input.defaultTemplateId ?? null,
    holderEmailField: input.holderEmailField ?? null,
    autoCreate: input.autoCreate ?? false,
    autoEmail: input.autoEmail ?? false,
    onMissing: input.onMissing ?? 'flag',
    mode,
    intervalSeconds: input.intervalSeconds ?? null,
    maxConcurrency: input.maxConcurrency ?? null,
    requestsPerMinute: input.requestsPerMinute ?? null,
    enabled: true,
    generation: 1,
    health: 'unknown',
    consecutiveFailures: 0,
    breakerOpenUntil: null,
    cursor: null,
    nextRunAt: schedules({ mode }) ? now : null,
    lastRunAt: null,
    lastSuccessAt: null,
    lastErrorCode: null,
    lastErrorAt: null,
    createdAt: now,
    updatedAt: now,
  };
  await insertConnection(sctx.env.DB, row);
  await recordAudit(sctx, {
    orgId: row.orgId,
    ...auditActor(actor),
    action: 'connection.create',
    targetType: 'connection',
    targetId: id,
    detail: { connectorType: def.type, mode, name: input.name },
  });
  return {
    ...toDto(sctx.env, row),
    ...(webhookSecret && !input.webhookSecret ? { webhookSecret } : {}),
  };
}

export async function remove(sctx: ServiceContext, actor: Actor, id: string): Promise<void> {
  const conn = await requireConnection(sctx, id);
  await deleteConnection(sctx.env.DB, id);
  await dropCredentials(sctx, [conn.credentialId, conn.webhookCredentialId]);
  await recordAudit(sctx, {
    orgId: conn.orgId,
    ...auditActor(actor),
    action: 'connection.delete',
    targetType: 'connection',
    targetId: id,
    detail: { connectorType: conn.connectorType, name: conn.name },
  });
}

export { auditActor, requireConnection } from './service-shared.ts';
export { update } from './service-update.ts';
export { connectorInfo };
