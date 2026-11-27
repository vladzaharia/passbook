import type { z } from 'zod';
import {
  type CreateWebhookEndpointSchema,
  LATEST_WEBHOOK_API_VERSION,
  type UpdateWebhookEndpointSchema,
  type WebhookEndpointDto,
} from '../../../shared/contracts/webhooks.ts';
import { authorityDenial, type Grant, grant } from '../../platform/authority.ts';
import type { Check } from '../../platform/authority-checks.ts';
import type { Actor } from '../../platform/context.ts';
import { loadKekRing } from '../../platform/crypto.ts';
import {
  AppError,
  ConflictError,
  NotFoundError,
  RateLimitedError,
  SandboxQuotaError,
  ValidationError,
} from '../../platform/errors.ts';
import { assertPublicHost, platformHostsOf } from '../../platform/safe-fetch.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { redactDetail } from '../audit/redact.ts';
import { capabilityChecks, tenantPrincipal } from '../passes/repo-authority.ts';
import { fenceOf, type WebhookAccess } from './access.ts';
import { noteActiveEndpoint } from './kick.ts';
import { countOrgTemplates, countRecentCreates } from './repo-api.ts';
import {
  deleteEndpoint,
  type EndpointRow,
  endpointSlot,
  getEndpoint,
  insertEndpoint,
  listEndpoints,
  updateEndpoint,
  webhooksIncluded,
} from './repo-endpoints.ts';
import { insertSecret } from './repo-secrets.ts';
import { resolverFor } from './resolver-memo.ts';
import { newEndpointSecret, sealSecret } from './secrets.ts';
import { hostOf, maskUrl, normalizeEndpointUrl } from './url.ts';

type CreateInput = z.infer<typeof CreateWebhookEndpointSchema>;
type UpdateInput = z.infer<typeof UpdateWebhookEndpointSchema>;

const HOUR = 3_600_000;
const MAX_CREATES_PER_HOUR = 20;

const TABLES = [
  'webhook_endpoints',
  'webhook_endpoint_secrets',
  'webhook_deliveries',
  'webhook_attempts',
  'webhook_captures',
] as const;

export const notFound = () =>
  new NotFoundError('Webhook endpoint not found.', 'WEBHOOK_ENDPOINT_NOT_FOUND');

/** A grant of this caller on the endpoint's org and mode. The statements and the audit row commit together. */
export function webhookGrant(
  ctx: ServiceContext,
  access: WebhookAccess,
  action: string,
  checks: Check[] = [],
): Grant {
  return grant(ctx, {
    purpose: `org_mode.webhooks.${action}`,
    principal: tenantPrincipal(access.authority),
    checks: [...capabilityChecks(access.authority), ...checks],
    tables: TABLES,
  });
}

/** Writes the audit row into the grant's batch. The detail holds the host, never the URL or a secret. */
export function auditEndpoint(
  ctx: ServiceContext,
  g: Grant,
  actor: Actor,
  access: WebhookAccess,
  action: string,
  endpointId: string,
  detail: Record<string, unknown>,
): void {
  g.audit({
    at: ctx.clock.now(),
    orgId: access.authority.orgId,
    actorType: actor.type,
    actorId: actor.id,
    action,
    targetType: 'webhook_endpoint',
    targetId: endpointId,
    requestId: null,
    ipPrefix: null,
    detail: JSON.stringify(redactDetail({ endpointId, mode: access.authority.mode, ...detail })),
  });
}

/**
 * A refused write is a missing row: an endpoint of another tenant, or one deleted a moment ago, aborts the
 * batch with `lineage`. Any other refusal (org or actor changed) keeps its 403.
 */
export async function commitEndpoint(g: Grant): Promise<D1Result[]> {
  try {
    return await g.commit();
  } catch (error) {
    if (authorityDenial(error) === 'lineage') throw notFound();
    // A sandbox at its endpoint cap is a conflict, not the generic SANDBOX_QUOTA.
    if (error instanceof SandboxQuotaError && error.feature === 'webhooks.endpoints')
      throw new AppError(
        'SANDBOX_ENDPOINT_LIMIT',
        409,
        `A sandbox holds ${error.limit} endpoints, the capture endpoint included. Delete one first.`,
        { feature: error.feature, limit: error.limit, used: error.used },
      );
    if (error instanceof Error && /webhook endpoint limit/.test(error.message))
      throw new ConflictError(
        'This mode already has 10 endpoints. Delete one first.',
        'WEBHOOK_ENDPOINT_LIMIT',
      );
    throw g.translate(error);
  }
}

export function toDto(e: EndpointRow, canManage: boolean): WebhookEndpointDto {
  return {
    id: e.id,
    orgId: e.orgId,
    mode: e.mode,
    url: canManage ? e.url : null,
    urlMasked: maskUrl(e.url),
    description: e.description,
    eventTypes: e.eventTypes as WebhookEndpointDto['eventTypes'],
    templateIds: e.templateIds,
    apiVersion: e.apiVersion,
    status: e.status,
    target: e.target,
    failingSince: e.failingSince,
    disabledAt: e.disabledAt,
    lastSuccessAt: e.lastSuccessAt,
    lastFailureAt: e.lastFailureAt,
    lastStatus: e.lastStatus,
    secretCreatedAt: e.secretCreatedAt,
    previousSecretExpiresAt: e.previousSecretExpiresAt,
    createdAt: e.createdAt,
  };
}

/** The static rules, then the host's addresses: a private or unresolvable host is refused at save time. */
async function checkedUrl(ctx: ServiceContext, raw: string): Promise<string> {
  const url = normalizeEndpointUrl(raw, platformHostsOf(ctx.env));
  await assertPublicHost(
    new URL(url).hostname,
    resolverFor(ctx.env, () => ctx.clock.now()),
  );
  return url;
}

/** A template filter names the org's own templates only. */
async function checkTemplates(
  ctx: ServiceContext,
  orgId: string,
  ids: readonly string[] | null | undefined,
) {
  if (!ids) return null;
  const unique = [...new Set(ids)];
  if ((await countOrgTemplates(ctx.env.DB, orgId, unique)) !== unique.length)
    throw new ValidationError(
      'A template does not belong to this organization.',
      [{ path: 'templateIds', message: 'Unknown template', code: 'custom' }],
      'UNKNOWN_TEMPLATE',
    );
  return unique;
}

export async function requireEndpoint(
  ctx: ServiceContext,
  access: WebhookAccess,
  id: string,
): Promise<EndpointRow> {
  const endpoint = await getEndpoint(ctx.env.DB, fenceOf(access), id);
  if (!endpoint) throw notFound();
  return endpoint;
}

export async function list(ctx: ServiceContext, access: WebhookAccess) {
  const rows = await listEndpoints(ctx.env.DB, fenceOf(access));
  return { items: rows.map((e) => toDto(e, access.canManage)), nextCursor: null };
}

export async function get(ctx: ServiceContext, access: WebhookAccess, id: string) {
  return toDto(await requireEndpoint(ctx, access, id), access.canManage);
}

export interface NewEndpointInput {
  url: string;
  target: 'url' | 'capture';
  description: string;
  eventTypes: readonly string[];
  templateIds: readonly string[] | null;
}

/** Writes the endpoint, its first secret and the audit row in one grant; the secret is shown once. */
export async function makeEndpoint(
  ctx: ServiceContext,
  actor: Actor,
  access: WebhookAccess,
  input: NewEndpointInput,
): Promise<{ endpoint: WebhookEndpointDto; secret: string }> {
  const { orgId, mode } = access.authority;
  // Each create costs a secret and an audit row: per org, counted from the audit log so a delete does not reset it.
  if ((await countRecentCreates(ctx.env.DB, orgId, ctx.clock.now() - HOUR)) >= MAX_CREATES_PER_HOUR)
    throw new RateLimitedError(3600, 'Too many endpoints created. Try again later.');
  const endpointId = ctx.ids.id();
  const secretId = ctx.ids.id();
  const secret = newEndpointSecret(ctx);
  const now = ctx.clock.now();
  const envelope = await sealSecret(await loadKekRing(ctx.env), secret, {
    secretId,
    orgId,
    endpointId,
    mode,
  });
  const g = webhookGrant(ctx, access, 'endpoint.create', [webhooksIncluded(), endpointSlot()]);
  insertEndpoint(g, {
    id: endpointId,
    url: input.url,
    target: input.target,
    description: input.description,
    eventTypes: input.eventTypes,
    templateIds: input.templateIds,
    apiVersion: LATEST_WEBHOOK_API_VERSION,
    createdBy: actor.type === 'user' ? actor.id : null,
    now,
  });
  insertSecret(g, { id: secretId, endpointId, envelope, now });
  auditEndpoint(ctx, g, actor, access, 'webhook.endpoint.create', endpointId, {
    host: hostOf(input.url),
    target: input.target,
    eventTypes: input.eventTypes,
  });
  await commitEndpoint(g);
  const endpoint = await requireEndpoint(ctx, access, endpointId);
  noteActiveEndpoint(ctx);
  ctx.log.info('webhooks.endpoint_created', { orgId, endpointId, host: hostOf(input.url) });
  return { endpoint: toDto(endpoint, true), secret };
}

/** `dryRun` validates everything a create would and writes nothing. */
export async function create(
  ctx: ServiceContext,
  actor: Actor,
  access: WebhookAccess,
  input: CreateInput,
  dryRun: boolean,
): Promise<{ endpoint: WebhookEndpointDto; secret: string } | null> {
  const { orgId } = access.authority;
  const url = await checkedUrl(ctx, input.url);
  const templateIds = await checkTemplates(ctx, orgId, input.templateIds);
  if (dryRun) return null;
  return makeEndpoint(ctx, actor, access, {
    url,
    target: 'url',
    description: input.description ?? '',
    eventTypes: input.eventTypes,
    templateIds,
  });
}

export async function update(
  ctx: ServiceContext,
  actor: Actor,
  access: WebhookAccess,
  id: string,
  input: UpdateInput,
): Promise<WebhookEndpointDto> {
  const current = await requireEndpoint(ctx, access, id);
  if (input.url !== undefined && current.target === 'capture')
    throw new ValidationError(
      'A capture endpoint has no URL to change.',
      [{ path: 'url', message: 'Not allowed', code: 'custom' }],
      'CAPTURE_URL_FIXED',
    );
  const url = input.url === undefined ? undefined : await checkedUrl(ctx, input.url);
  const templateIds = await checkTemplates(ctx, access.authority.orgId, input.templateIds);
  const g = webhookGrant(ctx, access, 'endpoint.update');
  updateEndpoint(
    g,
    id,
    {
      ...(url === undefined ? {} : { url }),
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.eventTypes === undefined ? {} : { eventTypes: input.eventTypes }),
      ...(input.templateIds === undefined ? {} : { templateIds }),
      ...(input.apiVersion === undefined ? {} : { apiVersion: input.apiVersion }),
      ...(input.status === undefined ? {} : { status: input.status }),
    },
    ctx.clock.now(),
  );
  const changed = Object.keys(input).filter(
    (k) => (input as Record<string, unknown>)[k] !== undefined,
  );
  auditEndpoint(ctx, g, actor, access, 'webhook.endpoint.update', id, {
    host: hostOf(url ?? current.url),
    ...(url !== undefined && hostOf(url) !== hostOf(current.url)
      ? { previousHost: hostOf(current.url) }
      : {}),
    changed,
    ...(input.eventTypes ? { eventTypes: input.eventTypes } : {}),
    ...(input.status ? { status: input.status } : {}),
  });
  await commitEndpoint(g);
  return toDto(await requireEndpoint(ctx, access, id), true);
}

export async function remove(
  ctx: ServiceContext,
  actor: Actor,
  access: WebhookAccess,
  id: string,
): Promise<void> {
  const current = await requireEndpoint(ctx, access, id);
  const g = webhookGrant(ctx, access, 'endpoint.delete');
  deleteEndpoint(g, id);
  auditEndpoint(ctx, g, actor, access, 'webhook.endpoint.delete', id, {
    host: hostOf(current.url),
  });
  await commitEndpoint(g);
}
