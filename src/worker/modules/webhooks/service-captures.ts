import type { z } from 'zod';
import type {
  WebhookCaptureDto,
  WebhookCaptureListQuerySchema,
} from '../../../shared/contracts/webhook-captures.ts';
import { SUBSCRIBABLE_EVENT_TYPES } from '../../../shared/contracts/webhooks.ts';
import type { Actor } from '../../platform/context.ts';
import { loadKekRing } from '../../platform/crypto.ts';
import { ConflictError, NotFoundError, RateLimitedError } from '../../platform/errors.ts';
import { checkRateLimit } from '../../platform/rate-limit.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { fenceOf, type WebhookAccess } from './access.ts';
import { assertCaptureHome, CAPTURE_URL, openActiveSecrets, storeCapture } from './capture.ts';
import { captureEndpointId, getCapture, listCaptures } from './repo-capture.ts';
import type { EndpointRow } from './repo-endpoints.ts';
import { makeEndpoint, requireEndpoint, toDto } from './service.ts';

type ListQuery = z.infer<typeof WebhookCaptureListQuerySchema>;

const captureNotFound = () => new NotFoundError('Capture not found.', 'WEBHOOK_CAPTURE_NOT_FOUND');

/** An endpoint that stores what it is sent. Any other reads as not a capture endpoint. */
async function requireCapture(
  ctx: ServiceContext,
  access: WebhookAccess,
  id: string,
): Promise<EndpointRow> {
  const endpoint = await requireEndpoint(ctx, access, id);
  if (endpoint.target !== 'capture')
    throw new ConflictError('This endpoint sends to a URL.', 'NOT_A_CAPTURE_ENDPOINT');
  return endpoint;
}

export async function list(ctx: ServiceContext, access: WebhookAccess, id: string, q: ListQuery) {
  await requireCapture(ctx, access, id);
  return listCaptures(ctx.env.DB, fenceOf(access), id, q);
}

export async function get(
  ctx: ServiceContext,
  access: WebhookAccess,
  id: string,
  captureId: string,
): Promise<WebhookCaptureDto> {
  await requireCapture(ctx, access, id);
  const capture = await getCapture(ctx.env.DB, fenceOf(access), id, captureId);
  if (!capture) throw captureNotFound();
  return capture;
}

/**
 * Signs the stored body again with a fresh timestamp and stores it as a new capture: the same event id and
 * bytes, a new signature, so a receiver's dedupe on the event id is exercised. Nothing is sent.
 */
export async function replay(
  ctx: ServiceContext,
  access: WebhookAccess,
  id: string,
  captureId: string,
): Promise<WebhookCaptureDto> {
  const endpoint = await requireCapture(ctx, access, id);
  const source = await get(ctx, access, id, captureId);
  const { orgId, mode } = access.authority;
  if (!(await checkRateLimit(ctx.env, 'RL_WEBHOOK_OUT', `test:${orgId}:${mode}`)))
    throw new RateLimitedError();
  const secrets = await openActiveSecrets(ctx, await loadKekRing(ctx.env), endpoint);
  if (secrets.length === 0)
    throw new ConflictError('The endpoint has no signing secret.', 'SECRET_UNAVAILABLE');
  return storeCapture(ctx, endpoint, {
    eventId: source.eventId,
    eventType: source.type,
    body: source.body,
    trigger: 'replay',
    secrets,
    now: ctx.clock.now(),
  });
}

/**
 * The current signing secret of a capture endpoint. Its deliveries go nowhere, so it protects nothing
 * outside the sandbox; the Verify panel needs it to check a capture in the browser.
 */
export async function revealSecret(
  ctx: ServiceContext,
  access: WebhookAccess,
  id: string,
): Promise<string> {
  const endpoint = await requireCapture(ctx, access, id);
  await assertCaptureHome(ctx, endpoint.orgId, endpoint.mode);
  const [current] = await openActiveSecrets(ctx, await loadKekRing(ctx.env), endpoint);
  if (!current)
    throw new ConflictError('The endpoint has no signing secret.', 'SECRET_UNAVAILABLE');
  return current;
}

/**
 * The org's capture endpoint, made if it has none: the secret comes back once, with the new one. An org
 * that has one answers with it and a null secret, so a sandbox made before captures existed is backfilled by
 * the next call.
 */
export async function ensureCapture(
  ctx: ServiceContext,
  actor: Actor,
  access: WebhookAccess,
  eventTypes?: readonly string[],
): Promise<{ endpoint: ReturnType<typeof toDto>; secret: string | null; created: boolean }> {
  const { orgId, mode } = access.authority;
  await assertCaptureHome(ctx, orgId, mode);
  const existing = await captureEndpointId(ctx.env.DB, orgId);
  if (existing)
    return {
      endpoint: toDto(await requireEndpoint(ctx, access, existing), true),
      secret: null,
      created: false,
    };
  const made = await makeEndpoint(ctx, actor, access, {
    url: CAPTURE_URL,
    target: 'capture',
    description: 'Test capture endpoint',
    eventTypes: eventTypes ?? SUBSCRIBABLE_EVENT_TYPES,
    templateIds: null,
  });
  return { ...made, created: true };
}
