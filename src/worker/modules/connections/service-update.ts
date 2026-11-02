import type { Actor } from '../../platform/context.ts';
import { ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { toDto } from './dto.ts';
import { schedules } from './health.ts';
import { validateMapping } from './mapping.ts';
import { type ConnectionPatch, patchConnection } from './repo.ts';
import { dropCredentials, newWebhookSecret, storeCredential } from './secrets.ts';
import {
  auditActor,
  type Created,
  FENCED,
  requireConnection,
  secretsFor,
  type UpdateInput,
} from './service-shared.ts';
import {
  assertModeSupported,
  assertPointer,
  assertSafeUrls,
  assertTemplateUsable,
  parseWith,
  requireConnector,
} from './validate.ts';

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
