import type { Mode } from '../../../shared/contracts/common.ts';
import {
  type ScanSetupCheck,
  type ScanSetupIntent,
  type ScanSetupPlan,
  type ScanSetupResult,
  ScanSetupResultSchema,
} from '../../../shared/contracts/scan-setup-intent.ts';
import { SCAN_SETUP_COPY } from '../../../shared/copy/scan-setup.ts';
import { planScanSetup } from '../../../shared/scan-setup-plan.ts';
import type { ApiKeyAuth, SessionAuth } from '../../platform/auth.ts';
import {
  BadRequestError,
  ConflictError,
  type FieldIssue,
  NotFoundError,
  ValidationError,
} from '../../platform/errors.ts';
import { idempotencyKeyHeader, principalOf, withIdempotency } from '../../platform/idempotency.ts';
import type { IdempotencyId } from '../../platform/repo-idempotency.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { type TenantPassWrite, tenantAuthorityOf } from '../passes/http.ts';
import { createPairing } from './pairing.ts';
import { unpairedExpired } from './repo-setup-intent.ts';
import { loadScanner } from './scanner-views.ts';
import { applySetupPlan, prepareForCaller, redacted } from './setup-intent-apply.ts';
import { loadSetupFacts, type SetupFacts } from './setup-intent-load.ts';
import { withFreeNames } from './setup-intent-plan.ts';

const fill = (text: string, params: Record<string, string> = {}) =>
  text.replace(/\{(\w+)\}/g, (m, k: string) => params[k] ?? m);

/** A check as a problem entry: the door it is about as the path, the check's code, its copy. */
export const checkIssue = (c: ScanSetupCheck): FieldIssue => ({
  path: c.door ? `doors.${Number(c.door.replace('door-', '')) - 1}` : '',
  code: c.code,
  message: fill(
    SCAN_SETUP_COPY.checks[c.message as keyof typeof SCAN_SETUP_COPY.checks] ?? c.message,
    c.params,
  ),
});

/** Reads, plans and checks; nothing is written. Errors in the intent or the plan refuse here. */
export async function planSetupIntent(
  ctx: ServiceContext,
  authority: TenantPassWrite,
  intent: ScanSetupIntent,
): Promise<{ plan: ScanSetupPlan; facts: SetupFacts }> {
  const facts = await loadSetupFacts(ctx, authority.orgId, authority.mode, intent);
  const planned = planScanSetup(intent, facts.plan);
  if (!planned.ok)
    throw new ValidationError(
      'This setup needs changes.',
      planned.issues.map((i) => ({
        path: i.path.join('.'),
        code: i.code,
        message: fill(SCAN_SETUP_COPY.issues[i.code], i.params),
      })),
      'SCAN_SETUP_INVALID',
    );
  return { plan: withFreeNames(planned.plan, facts.taken, intent), facts };
}

/** A key bound to another org finds no such org, rather than learning it exists. */
async function authorityOf(
  ctx: ServiceContext,
  auth: SessionAuth | ApiKeyAuth,
  orgId: string,
): Promise<TenantPassWrite> {
  if (auth.kind === 'api_key' && auth.orgId !== orgId)
    throw new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');
  return tenantAuthorityOf(ctx, auth, orgId, 'scanning:manage');
}

/** The plan and its checks, no writes: what the wizard's review shows. */
export async function dryRunSetup(
  ctx: ServiceContext,
  auth: SessionAuth | ApiKeyAuth,
  intent: ScanSetupIntent,
): Promise<ScanSetupPlan> {
  const authority = await authorityOf(ctx, auth, intent.orgId);
  const { plan, facts } = await planSetupIntent(ctx, authority, intent);
  // The same per-object and scope rules as apply, over the same plan; nothing is written.
  const actorId = auth.kind === 'api_key' ? auth.keyId : auth.userId;
  // An error check already says what is wrong, and the object rules would stop on the same thing first.
  if (!plan.checks.some((c) => c.level === 'error'))
    await prepareForCaller(ctx, actorId, authority, plan, facts, { origin: '' });
  return plan;
}

/** A replay: the same ids, no PINs; a device whose code ran out and was never paired gets a new one. */
async function replayOf(
  ctx: ServiceContext,
  stored: ScanSetupResult,
  userId: string,
  authority: TenantPassWrite,
  origin: string,
): Promise<ScanSetupResult> {
  const result = { ...stored, replayed: true, pairingReissued: false };
  if (authority.kind !== 'session') return result;
  const ids = result.sessions.flatMap((s) => s.devices.map((d) => d.id));
  const rows = await unpairedExpired(ctx.env.DB, authority.orgId, ids, ctx.clock.now());
  const expired = new Set(rows.map((r) => r.id));
  if (expired.size === 0) return result;
  const fresh = new Map<string, Awaited<ReturnType<typeof createPairing>>>();
  for (const id of expired)
    fresh.set(id, await createPairing(ctx, userId, await loadScanner(ctx, id), origin, authority));
  return {
    ...result,
    pairingReissued: true,
    sessions: result.sessions.map((s) => ({
      ...s,
      devices: s.devices.map((d) => ({ ...d, pairing: fresh.get(d.id) ?? null })),
    })),
  };
}

export interface SetupRequest {
  intent: ScanSetupIntent;
  idempotencyKey: string | undefined;
  method: string;
  path: string;
  origin: string;
  ip?: string | null;
}

/**
 * The one-call setup: plan, check, commit once. `Idempotency-Key` is required. The same key with the
 * same body replays the answer (same ids, no secrets); with another body it is 409.
 */
export async function applyScanSetup(
  ctx: ServiceContext,
  auth: SessionAuth | ApiKeyAuth,
  request: SetupRequest,
): Promise<ScanSetupResult> {
  const { intent, origin } = request;
  const authority = await authorityOf(ctx, auth, intent.orgId);
  const key = idempotencyKeyHeader(request.idempotencyKey);
  if (key === undefined)
    throw new BadRequestError('Send an Idempotency-Key header.', 'SCAN_SETUP_KEY_REQUIRED');
  const actorId = auth.kind === 'api_key' ? auth.keyId : auth.userId;
  let fresh: ScanSetupResult | null = null;
  const scope = {
    orgId: authority.orgId,
    mode: authority.mode as Mode,
    principal: principalOf(auth),
    operation: 'POST /scanning-sessions/setup',
    key,
  };
  const settle: IdempotencyId = [scope.orgId, scope.mode, scope.principal, scope.operation, key];
  const outcome = await withIdempotency(
    ctx,
    {
      ...scope,
      request: { method: request.method, path: request.path, body: intent },
    },
    async () => {
      const { plan, facts } = await planSetupIntent(ctx, authority, intent);
      const errors = plan.checks.filter((c) => c.level === 'error');
      if (errors.length > 0)
        throw new ValidationError(
          'This setup has problems to fix first.',
          errors.map(checkIssue),
          'SCAN_SETUP_CHECKS_FAILED',
        );
      fresh = await applySetupPlan(ctx, actorId, authority, plan, facts, {
        origin,
        settle,
        ...(request.ip ? { ip: request.ip } : {}),
      });
      return { status: 200, body: redacted(fresh) };
    },
  ).catch((error: unknown) => {
    if (error instanceof ValidationError && error.code === 'IDEMPOTENCY_KEY_REUSED')
      throw new ConflictError(
        'This Idempotency-Key was used for a different setup.',
        'SCAN_SETUP_KEY_REUSED',
      );
    throw error;
  });
  if (!outcome.replayed && fresh) return fresh;
  return replayOf(ctx, ScanSetupResultSchema.parse(outcome.body), actorId, authority, origin);
}
