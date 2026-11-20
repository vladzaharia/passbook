import type { Mode } from '../../../shared/contracts/common.ts';
import type { WebhookCaptureDto } from '../../../shared/contracts/webhook-captures.ts';
import { WEBHOOK_CAPTURE_LIMITS } from '../../../shared/contracts/webhook-captures.ts';
import type { KekRing } from '../../platform/crypto.ts';
import { ConflictError, RateLimitedError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { capturesThisHour, getCapture, isDeveloperOrg } from './repo-capture.ts';
import { captureStmt } from './repo-delivery-state.ts';
import type { EndpointRow } from './repo-endpoints.ts';
import { activeSecrets } from './repo-secrets.ts';
import { openSecret } from './secrets.ts';
import { requestHeaders } from './sign.ts';

/**
 * What a capture endpoint's `url` holds. It is not a place: the delivery path stores the request and
 * never reads this, and the `.invalid` host cannot resolve anywhere.
 */
export const CAPTURE_URL = 'https://capture.invalid/';

const HOUR = 3_600_000;

/** A capture endpoint belongs to a developer org in Test: nowhere else may make or keep one. */
export async function assertCaptureHome(
  ctx: ServiceContext,
  orgId: string,
  mode: Mode,
): Promise<void> {
  if (mode !== 'test' || !(await isDeveloperOrg(ctx.env.DB, orgId)))
    throw new ConflictError(
      'Capture endpoints are for a sandbox in Test mode.',
      'CAPTURE_DEVELOPER_ONLY',
    );
}

const limited = (now: number) =>
  new RateLimitedError(
    Math.max(1, Math.ceil(((Math.floor(now / HOUR) + 1) * HOUR - now) / 1000)),
    `Capture limit reached: ${WEBHOOK_CAPTURE_LIMITS.perHour} an hour. Try again next hour.`,
  );

/** True when the org has used its captures for this clock hour: a delivery waits instead of failing. */
export async function captureHourFull(ctx: ServiceContext, orgId: string): Promise<boolean> {
  return (
    (await capturesThisHour(ctx.env.DB, orgId, ctx.clock.now())) >= WEBHOOK_CAPTURE_LIMITS.perHour
  );
}

/** The secrets that sign for this endpoint now; one that fails to open is skipped, as a delivery does. */
export async function openActiveSecrets(
  ctx: ServiceContext,
  ring: KekRing,
  endpoint: Pick<EndpointRow, 'id' | 'orgId' | 'mode'>,
): Promise<string[]> {
  const rows = await activeSecrets(ctx.env.DB, endpoint, endpoint.id, ctx.clock.now());
  const out: string[] = [];
  for (const row of rows) {
    try {
      out.push(
        await openSecret(ring, row.envelope, {
          secretId: row.id,
          orgId: endpoint.orgId,
          endpointId: endpoint.id,
          mode: endpoint.mode,
        }),
      );
    } catch {
      ctx.log.error('webhooks.secret_unavailable', {
        orgId: endpoint.orgId,
        endpointId: endpoint.id,
        code: 'SECRET_UNAVAILABLE',
      });
    }
  }
  return out;
}

export interface CaptureInput {
  eventId: string;
  eventType: string;
  /** The raw body to sign: what a receiver would read. */
  body: string;
  trigger: 'event' | 'replay' | 'test';
  secrets: readonly string[];
  now: number;
}

/** The headers a delivery of this body would carry, signed by the same code. Nothing is sent. */
export const signedHeaders = (input: CaptureInput) =>
  requestHeaders({
    eventId: input.eventId,
    eventType: input.eventType,
    secrets: input.secrets,
    nowMs: input.now,
    body: input.body,
  });

/** A body past the cap is refused here; the table refuses it too. */
export function assertCaptureSize(body: string): void {
  if (new TextEncoder().encode(body).length > WEBHOOK_CAPTURE_LIMITS.maxBytes)
    throw new ValidationError('The capture is over 256 KiB.', [], 'CAPTURE_TOO_LARGE');
}

/** Stores one signed request on a capture endpoint, for a test send or a replay. */
export async function storeCapture(
  ctx: ServiceContext,
  endpoint: EndpointRow,
  input: CaptureInput,
): Promise<WebhookCaptureDto> {
  if (endpoint.target !== 'capture')
    throw new ConflictError('This endpoint sends to a URL.', 'NOT_A_CAPTURE_ENDPOINT');
  await assertCaptureHome(ctx, endpoint.orgId, endpoint.mode);
  const { body } = input;
  assertCaptureSize(body);
  const headers = await signedHeaders(input);
  const id = ctx.ids.id();
  try {
    await captureStmt(
      ctx.env.DB,
      { endpointId: endpoint.id, orgId: endpoint.orgId, mode: endpoint.mode },
      {
        id,
        eventId: input.eventId,
        eventType: input.eventType,
        trigger: input.trigger,
        headers,
        body,
        durationMs: Math.max(0, ctx.clock.now() - input.now),
        at: input.now,
      },
    ).run();
  } catch (error) {
    if (error instanceof Error && /capture hourly limit/.test(error.message))
      throw limited(input.now);
    throw error;
  }
  ctx.log.info('webhooks.captured', {
    orgId: endpoint.orgId,
    endpointId: endpoint.id,
    trigger: input.trigger,
  });
  const stored = await getCapture(ctx.env.DB, endpoint, endpoint.id, id);
  if (!stored) throw new ConflictError('The capture was not stored.', 'CAPTURE_NOT_STORED');
  return stored;
}
