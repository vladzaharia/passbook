import type { Actor } from '../../platform/context.ts';
import { ConflictError, ForbiddenError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import type { ConnectionAuthority } from './access.ts';
import { toDto } from './dto.ts';
import { connectorItem, requireConnectorEntitled } from './entitlement.ts';
import { schedules } from './health.ts';
import { assertMayIssue, updateIssues } from './issuing.ts';
import { validateMapping } from './mapping.ts';
import { type ConnectionPatch, type ConnectionRow, patchConnection } from './repo.ts';
import {
  assertSecretFree,
  pastesSecret,
  rethrowSecretReuse,
  secretFingerprint,
} from './secret-fingerprint.ts';
import { dropCredentials, newWebhookSecret, overlapPatch, storeCredential } from './secrets.ts';
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
import { validateVoidWhen } from './void-when.ts';

/** Keys the connector fixes at creation (the webhook recipe) cannot change: bound passes hold its refs. */
function assertFixedConfig(
  def: ReturnType<typeof requireConnector>,
  conn: ConnectionRow,
  next: Record<string, unknown>,
): void {
  if (!def.fixedConfig?.length) return;
  const stored = def.configSchema.parse(
    conn.connectorVersion !== def.version && def.migrate
      ? def.migrate(conn.connectorVersion, conn.config)
      : conn.config,
  ) as Record<string, unknown>;
  for (const key of def.fixedConfig) {
    if (JSON.stringify(stored[key]) !== JSON.stringify(next[key])) {
      throw new ValidationError('This setting cannot be changed. Create a new connection.', [
        { path: `config.${key}`, message: 'Fixed after creation.' },
      ]);
    }
  }
}

const storedConfig = (def: ReturnType<typeof requireConnector>, conn: ConnectionRow) =>
  def.configSchema.parse(
    conn.connectorVersion !== def.version && def.migrate
      ? def.migrate(conn.connectorVersion, conn.config)
      : conn.config,
  );

const originsOf = (urls: string[]) => new Set(urls.map((u) => new URL(u).origin));

/** A stored credential is bound to the origins it was entered for; a new origin needs a new credential. */
function assertCredentialOrigin(
  def: ReturnType<typeof requireConnector>,
  conn: ConnectionRow,
  next: Record<string, unknown>,
  secrets: UpdateInput['secrets'],
): void {
  if (!conn.credentialId || !def.urls) return;
  if (secrets !== undefined && Object.keys(secrets).length > 0) return;
  const known = originsOf(def.urls(storedConfig(def, conn) as never));
  const moved = [...originsOf(def.urls(next as never))].some((o) => !known.has(o));
  if (moved) {
    throw new ValidationError('Enter the credential again to use a new host.', [
      { path: 'secrets', message: 'Required when the host changes.' },
    ]);
  }
}

/** A connection the plan no longer includes keeps running and stays editable, but may not move to a new origin. */
async function assertOriginMoveEntitled(
  sctx: ServiceContext,
  def: ReturnType<typeof requireConnector>,
  conn: ConnectionRow,
  next: Record<string, unknown>,
): Promise<void> {
  if (!def.egress) return;
  const known = new Set(def.egress(storedConfig(def, conn) as never));
  if (def.egress(next as never).every((o) => known.has(o))) return;
  await requireConnectorEntitled(sctx, conn.orgId, connectorItem(def.type, next));
}

export async function update(
  sctx: ServiceContext,
  actor: Actor,
  id: string,
  input: UpdateInput,
  authority?: ConnectionAuthority,
): Promise<Created> {
  const conn = await requireConnection(sctx, id);
  if (authority && authority.orgId !== conn.orgId) throw new ForbiddenError();
  const issues = await updateIssues(sctx.env.DB, input, conn);
  if (issues) assertMayIssue(authority);
  const def = requireConnector(conn.connectorType);
  const now = sctx.clock.now();
  const patch: ConnectionPatch = { updatedAt: now };
  const changed = new Set<string>();
  let generated: string | undefined;
  const staleCredentials: (string | null)[] = [];
  const newCredentials: string[] = [];
  let connectorCredential: string | undefined;
  let webhookCredential: string | undefined;
  const set = <K extends keyof ConnectionPatch>(key: K, value: ConnectionPatch[K]) => {
    patch[key] = value;
    changed.add(key);
  };

  if (input.name !== undefined) set('name', input.name);
  if (input.config !== undefined) {
    const config = parseWith(def.configSchema, input.config, 'config');
    assertFixedConfig(def, conn, config);
    await assertOriginMoveEntitled(sctx, def, conn, config as Record<string, unknown>);
    await assertSafeUrls(sctx, def.urls?.(config) ?? []);
    assertCredentialOrigin(def, conn, config, input.secrets);
    patch.config = config;
    patch.connectorVersion = def.version;
    patch.cursor = null;
    changed.add('config');
  }
  if (input.secrets !== undefined) {
    const json = secretsFor(def, input.secrets);
    if (json === '{}') patch.credentialId = null;
    else connectorCredential = json;
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
  if (input.voidWhen !== undefined) {
    validateVoidWhen(input.voidWhen);
    set('voidWhen', input.voidWhen);
  }
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
    webhookCredential = secret;
    // The replaced secret stays valid for the overlap; the one before it is dropped now.
    const overlap = input.overlapSeconds ?? 86_400;
    Object.assign(patch, overlapPatch(conn, overlap, now));
    staleCredentials.push(conn.webhookPrevCredentialId);
    if (overlap === 0) staleCredentials.push(conn.webhookCredentialId);
    if (input.webhookSecret === undefined) generated = secret;
    // A pasted recipe secret is fingerprinted (unique platform-wide); a generated one needs no check.
    patch.webhookSecretFp =
      input.webhookSecret !== undefined && pastesSecret(def, conn.config)
        ? await secretFingerprint(sctx, input.webhookSecret)
        : null;
    if (patch.webhookSecretFp) await assertSecretFree(sctx, patch.webhookSecretFp, conn.id);
    changed.add('webhookSecret');
  }

  const enabled = input.enabled ?? conn.enabled;
  if (input.enabled !== undefined) changed.add('enabled');
  const fenced = FENCED.some((k) => changed.has(k));
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

  try {
    if (connectorCredential !== undefined) {
      const credentialId = await storeCredential(
        sctx,
        {
          orgId: conn.orgId,
          kind: 'connector',
          value: connectorCredential,
          createdBy: actor.type === 'user' ? actor.id : null,
        },
        authority ?? 'system',
      );
      newCredentials.push(credentialId);
      patch.credentialId = credentialId;
    }
    if (webhookCredential !== undefined) {
      const credentialId = await storeCredential(
        sctx,
        {
          orgId: conn.orgId,
          kind: 'webhook',
          value: webhookCredential,
          createdBy: actor.type === 'user' ? actor.id : null,
        },
        authority ?? 'system',
      );
      newCredentials.push(credentialId);
      patch.webhookCredentialId = credentialId;
    }
    const updated = await patchConnection(sctx, id, patch, {
      actor: { orgId: conn.orgId, authority, issuing: issues },
      ...(fenced ? { generation: conn.generation } : {}),
    });
    if (updated === 0) {
      throw new ConflictError('The connection changed. Reload and retry.', 'CONNECTION_CONFLICT');
    }
  } catch (error) {
    // A reported failure can still follow a committed update; preserve any linked credentials.
    await dropCredentials(sctx, [...newCredentials, ...staleCredentials]);
    return rethrowSecretReuse(sctx, error);
  }
  await dropCredentials(sctx, staleCredentials);
  await recordAudit(sctx, {
    orgId: conn.orgId,
    ...auditActor(actor),
    action: 'connection.update',
    targetType: 'connection',
    targetId: id,
    detail: {
      changed: [...changed],
      ...(input.config !== undefined && def.urls
        ? {
            from: [...originsOf(def.urls(storedConfig(def, conn) as never))],
            to: [...originsOf(def.urls(patch.config as never))],
          }
        : {}),
    },
  });
  const fresh = await requireConnection(sctx, id);
  return { ...toDto(sctx.env, fresh), ...(generated ? { webhookSecret: generated } : {}) };
}
