import type { z } from 'zod';
import type {
  ConnectionCreatedSchema,
  ConnectionDetailSchema,
  ConnectionListQuerySchema,
  CreateConnectionSchema,
  UpdateConnectionSchema,
} from '../../../shared/contracts/index.ts';
import type { Actor } from '../../platform/context.ts';
import { NotFoundError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { connectorInfo, percentile, toDto } from './dto.ts';
import { schedules } from './health.ts';
import { validateMapping } from './mapping.ts';
import {
  type ConnectionPatch,
  type ConnectionRow,
  deleteConnection,
  getConnection,
  insertConnection,
  listConnections,
  patchConnection,
} from './repo.ts';
import { listRuns, runStats } from './repo-runs.ts';
import { dropCredentials, newWebhookSecret, storeCredential } from './secrets.ts';
import {
  assertModeSupported,
  assertOrg,
  assertPointer,
  assertSafeUrls,
  assertTemplateUsable,
  parseWith,
  requireConnector,
} from './validate.ts';

type CreateInput = z.infer<typeof CreateConnectionSchema>;
type UpdateInput = z.infer<typeof UpdateConnectionSchema>;
type Created = z.infer<typeof ConnectionCreatedSchema>;

/** Changing any of these invalidates runs already in flight. */
const FENCED = [
  'config',
  'secrets',
  'mapping',
  'defaultTemplateId',
  'holderEmailField',
  'autoCreate',
  'autoEmail',
  'onMissing',
] as const;

export function auditActor(actor: Actor): { actorType: Actor['type']; actorId: string | null } {
  return { actorType: actor.type, actorId: actor.id };
}

export async function requireConnection(sctx: ServiceContext, id: string): Promise<ConnectionRow> {
  const conn = await getConnection(sctx.env.DB, id);
  if (!conn) throw new NotFoundError('Connection not found.', 'CONNECTION_NOT_FOUND');
  return conn;
}

function secretsFor(
  def: ReturnType<typeof requireConnector>,
  secrets: Record<string, string>,
): string {
  if (!def.secretSchema) {
    if (Object.keys(secrets).length > 0) {
      throw new ValidationError('This connector takes no secrets.', [
        { path: 'secrets', message: 'Not supported.' },
      ]);
    }
    return '{}';
  }
  return JSON.stringify(parseWith(def.secretSchema, secrets, 'secrets'));
}

export async function listAll(
  sctx: ServiceContext,
  query: z.infer<typeof ConnectionListQuerySchema>,
) {
  const rows = await listConnections(sctx.env.DB, {
    orgId: query.orgId,
    health: query.health,
    cursor: query.cursor,
    limit: query.limit + 1,
  });
  const page = rows.slice(0, query.limit);
  return {
    items: page.map((r) => toDto(sctx.env, r)),
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

export async function update(
  sctx: ServiceContext,
  actor: Actor,
  id: string,
  input: UpdateInput,
): Promise<Created> {
  const conn = await requireConnection(sctx, id);
  const def = requireConnector(conn.connectorType);
  const now = sctx.clock.now();
  const patch: ConnectionPatch = { updatedAt: now };
  const changed = new Set<string>();
  let generated: string | undefined;
  const staleCredentials: (string | null)[] = [];
  const set = <K extends keyof ConnectionPatch>(key: K, value: ConnectionPatch[K]) => {
    patch[key] = value;
    changed.add(key);
  };

  if (input.name !== undefined) set('name', input.name);
  if (input.config !== undefined) {
    const config = parseWith(def.configSchema, input.config, 'config');
    await assertSafeUrls(sctx, def.urls?.(config) ?? []);
    patch.config = config;
    patch.connectorVersion = def.version;
    patch.cursor = null;
    changed.add('config');
  }
  if (input.secrets !== undefined) {
    const json = secretsFor(def, input.secrets);
    patch.credentialId =
      json === '{}'
        ? null
        : await storeCredential(sctx, {
            orgId: conn.orgId,
            kind: 'connector',
            value: json,
            createdBy: actor.id,
          });
    staleCredentials.push(conn.credentialId);
    patch.cursor = null;
    changed.add('secrets');
  }
  if (input.mapping !== undefined) {
    validateMapping(input.mapping);
    patch.mapping = input.mapping;
    changed.add('mapping');
  }
  if (input.holderEmailField !== undefined) {
    assertPointer(input.holderEmailField, 'holderEmailField');
    patch.holderEmailField = input.holderEmailField;
    changed.add('holderEmailField');
  }
  const templateId = input.defaultTemplateId ?? conn.defaultTemplateId;
  if (input.defaultTemplateId !== undefined) {
    await assertTemplateUsable(sctx, conn.orgId, input.defaultTemplateId);
    patch.defaultTemplateId = input.defaultTemplateId;
    changed.add('defaultTemplateId');
  }
  const autoCreate = input.autoCreate ?? conn.autoCreate;
  if (autoCreate && !templateId) {
    throw new ValidationError('Auto-create needs a default template.', [
      { path: 'defaultTemplateId', message: 'Required with autoCreate.' },
    ]);
  }
  if (input.autoCreate !== undefined) set('autoCreate', input.autoCreate);
  if (input.autoEmail !== undefined) set('autoEmail', input.autoEmail);
  if (input.onMissing !== undefined) set('onMissing', input.onMissing);
  for (const key of ['intervalSeconds', 'maxConcurrency', 'requestsPerMinute'] as const) {
    if (input[key] !== undefined) set(key, input[key]);
  }

  const mode = input.mode ?? conn.mode;
  if (input.mode !== undefined) {
    assertModeSupported(def, mode);
    patch.mode = mode;
    changed.add('mode');
  }
  if (input.webhookSecret !== undefined && !def.capabilities.webhook) {
    throw new ValidationError('This connector takes no webhooks.', [
      { path: 'webhookSecret', message: 'Not supported.' },
    ]);
  }
  const needsSecret =
    (mode === 'webhook' || mode === 'hybrid') && conn.webhookCredentialId === null;
  if (input.webhookSecret !== undefined || needsSecret) {
    const secret = input.webhookSecret ?? newWebhookSecret(sctx);
    patch.webhookCredentialId = await storeCredential(sctx, {
      orgId: conn.orgId,
      kind: 'webhook',
      value: secret,
      createdBy: actor.id,
    });
    staleCredentials.push(conn.webhookCredentialId);
    if (input.webhookSecret === undefined) generated = secret;
    changed.add('webhookSecret');
  }

  const enabled = input.enabled ?? conn.enabled;
  if (input.enabled !== undefined) changed.add('enabled');
  const fenced = FENCED.some((k) => changed.has(k));
  if (fenced) patch.generation = conn.generation + 1;
  if (input.enabled !== undefined || changed.has('mode') || fenced) {
    patch.enabled = enabled;
    if (!enabled) {
      patch.health = 'disabled';
      patch.nextRunAt = null;
    } else {
      if (input.enabled === true) {
        patch.health = 'unknown';
        patch.consecutiveFailures = 0;
        patch.breakerOpenUntil = null;
      }
      if (!schedules({ mode })) patch.nextRunAt = null;
      else if (fenced || input.enabled === true || changed.has('mode')) patch.nextRunAt = now;
    }
  }

  await patchConnection(sctx.env.DB, id, patch);
  await dropCredentials(sctx, staleCredentials);
  await recordAudit(sctx, {
    orgId: conn.orgId,
    ...auditActor(actor),
    action: 'connection.update',
    targetType: 'connection',
    targetId: id,
    detail: { changed: [...changed] },
  });
  const fresh = await requireConnection(sctx, id);
  return { ...toDto(sctx.env, fresh), ...(generated ? { webhookSecret: generated } : {}) };
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

export { connectorInfo };
