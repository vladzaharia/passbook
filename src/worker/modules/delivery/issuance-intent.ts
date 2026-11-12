import { strictEmail } from '../../../shared/email.ts';
import type { Job } from '../../jobs/types.ts';
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../platform/errors.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { AuditEntry } from '../audit/types.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import {
  bindPass,
  type ConnectionEmailAuthority,
  type ExpectedPassDelivery,
  type IssuedPassEmailRelease,
  matchesPass,
} from './binding.ts';
import {
  authorityMayQueue,
  captureActor,
  type DeliveryActor,
  systemActor,
} from './delivery-actor.ts';
import { parseContext } from './issuance-context.ts';
import {
  authorityActors,
  deferredActors,
  type QueueActors,
  queuedAudit,
} from './repo-email-queue.ts';
import {
  cancelStaleIssuance,
  deferFailedIssuance,
  deferIssuanceForRateLimit,
  dueIssuanceDeliveries,
  getIntent,
  hasPendingIssuanceTransfer,
} from './repo-issuance-recovery.ts';
import { insertIssuedPassEmail } from './repo-issued-email.ts';
import { getOutbox } from './repo-outbox.ts';
import {
  lostEnqueues,
  markDueEnqueued,
  revertEnqueued,
  touchEnqueued,
} from './repo-outbox-processing.ts';

const SEND_BATCH = 100;
const HOUR = 3_600_000;
const DAY = 86_400_000;
/** Pass emails per recipient per hour, and per org per day. */
export const EMAIL_RECIPIENT_HOURLY_CAP = 3;
export const EMAIL_ORG_DAILY_CAP = 500;

function message(row: { id: string; kind: 'push' | 'email' }): MessageSendRequest<Job> {
  const kind = row.kind === 'push' ? ('push.deliver' as const) : ('email.send' as const);
  return { body: { kind, outboxId: row.id }, contentType: 'json' };
}

async function sendRows(ctx: ServiceContext, rows: { id: string; kind: 'push' | 'email' }[]) {
  for (let i = 0; i < rows.length; i += SEND_BATCH) {
    await ctx.env.JOBS.sendBatch(rows.slice(i, i + SEND_BATCH).map(message));
  }
}

/**
 * Marks due rows `enqueued`, then sends them. A failed send reverts the mark so the next tick
 * retries; the sweeper covers a crash between the two steps.
 */
export async function dispatchOutbox(
  ctx: ServiceContext,
  options: { passId?: string; limit?: number } = {},
): Promise<number> {
  await recoverIssuanceDeliveries(ctx, options.passId);
  const rows = await markDueEnqueued(
    ctx.env.DB,
    ctx.clock.now(),
    options.limit ?? 200,
    options.passId,
  );
  if (rows.length === 0) return 0;
  try {
    await sendRows(ctx, rows);
  } catch (error) {
    await revertEnqueued(
      ctx.env.DB,
      rows.map((r) => r.id),
    );
    throw error;
  }
  return rows.length;
}

/** For `waitUntil`: dispatch failures are logged, never thrown into the request. */
export async function dispatchSafely(
  ctx: ServiceContext,
  options: { passId?: string } = {},
): Promise<void> {
  try {
    await dispatchOutbox(ctx, options);
  } catch (error) {
    ctx.log.error('outbox.dispatch_failed', { code: 'OUTBOX_DISPATCH', error });
  }
}

/** Re-sends rows stuck in `enqueued` (message lost after the mark). */
export async function redispatchLost(ctx: ServiceContext, graceMs: number): Promise<number> {
  const now = ctx.clock.now();
  const rows = await lostEnqueues(ctx.env.DB, now - graceMs, 200);
  if (rows.length === 0) return 0;
  await sendRows(ctx, rows);
  await touchEnqueued(
    ctx.env.DB,
    rows.map((r) => r.id),
    now,
  );
  return rows.length;
}

/** Resume by pass id on creation/replay and from the ordinary delivery sweeper. */
export async function scheduleIssuanceDelivery(
  ctx: ServiceContext,
  passId: string,
  dispatch = true,
): Promise<'queued' | 'deferred' | 'cancelled' | 'none'> {
  const db = ctx.env.DB;
  const row = await getIntent(db, passId);
  if (!row) return 'none';
  if (row.state === 'cancelled') return 'cancelled';
  if (row.state === 'queued') {
    const outbox = row.outbox_id ? await getOutbox(db, row.outbox_id) : null;
    if (outbox?.state === 'partial' || (!outbox && row.outcome === 'partial'))
      throw new AppError(
        'EMAIL_OUTCOME_UNKNOWN',
        409,
        'The original email may have been sent; its outcome must be resolved before retrying.',
      );
    if (!outbox) return row.outcome === 'sent' ? 'queued' : 'cancelled';
    return outbox.state === 'failed' || outbox.state === 'cancelled' ? 'cancelled' : 'queued';
  }
  if (await hasPendingIssuanceTransfer(db, passId)) return 'deferred';
  const context = parseContext(row);
  const pass = await getPass(db, passId);
  try {
    if (!context || !pass)
      throw new ConflictError('The issuance delivery changed.', 'DELIVERY_STALE');
    const execution = context.execution;
    // A system or connection issuance has no principal row: only a queue, cron or workflow context
    // may act for it, so a request leaves it pending for the next sweep.
    if (execution.kind !== 'tenant' && !ctx.job) return 'deferred';
    await enqueuePassEmail(ctx, {
      passId,
      to: row.recipient,
      attach: false,
      expected: pass,
      ...(context.connection ? { connection: context.connection } : {}),
      ...(execution.kind === 'tenant'
        ? {
            queuedFor: deferredActors(
              authorityActors(execution.authority, execution.additionalAuthority),
              [context.userRevision ?? undefined, context.additionalUserRevision ?? undefined],
            ),
          }
        : context.orgRevision === undefined
          ? {}
          : { queuedFor: [{ kind: 'system' as const, orgRevision: context.orgRevision }] }),
      issuanceIntentId: passId,
      schedule: false,
    });
    if (dispatch) ctx.waitUntil(dispatchSafely(ctx, { passId }));
    return 'queued';
  } catch (error) {
    if (error instanceof AppError && error.code === 'EMAIL_RATE_LIMITED') {
      await deferIssuanceForRateLimit(db, passId, row.transfer_id, ctx.clock.now() + 60_000);
      return 'deferred';
    }
    if (!(error instanceof ConflictError) && !(error instanceof ForbiddenError)) throw error;
    // A START or another scheduler may have won after our read. Never cancel its new lineage.
    await cancelStaleIssuance(
      db,
      passId,
      row.transfer_id,
      error instanceof ForbiddenError
        ? error.code === 'ORG_ACCESS_CHANGED'
          ? 'ORG_INACTIVE'
          : 'ACTOR_REVOKED'
        : 'DELIVERY_STALE',
    );
    const current = await getIntent(db, passId);
    if (current?.state === 'queued') return 'queued';
    return current?.state === 'cancelled' ? 'cancelled' : 'deferred';
  }
}

export async function recoverIssuanceDeliveries(
  ctx: ServiceContext,
  passId?: string,
): Promise<void> {
  const rows = await dueIssuanceDeliveries(ctx.env.DB, ctx.clock.now(), passId);
  for (const row of rows) {
    try {
      await scheduleIssuanceDelivery(ctx, row.pass_id, false);
    } catch {
      // A single transient failure must not monopolize every bounded sweep.
      await deferFailedIssuance(ctx.env.DB, row.pass_id, ctx.clock.now() + 60_000);
      ctx.log.error('delivery.issuance_retry_failed', {
        passId: row.pass_id,
        code: 'ISSUANCE_DELIVERY_RETRY',
      });
    }
  }
}

export async function enqueuePassEmail(
  ctx: ServiceContext,
  input: {
    passId: string;
    to: string;
    attach: boolean;
    expected: ExpectedPassDelivery;
    /** The live request's authority: its session or key must hold now. */
    authority?: TenantPassWrite;
    additionalAuthority?: TenantPassWrite;
    /** Durable actors captured earlier (the issuance scheduler only): no session is consulted. */
    queuedFor?: DeliveryActor[];
    connection?: ConnectionEmailAuthority;
    /** Accepted for callers; a release is checked at create and publish, never at mail time. */
    release?: IssuedPassEmailRelease;
    /** Reserved for the durable issuance scheduler. */
    issuanceIntentId?: string;
    schedule?: boolean;
    /** Recorded in the queueing batch, as one transaction with the mail. */
    auditEntry?: AuditEntry;
  },
): Promise<{ outboxId: string }> {
  const to = strictEmail(input.to);
  if (!to) throw new ValidationError('Enter a valid email address.', [], 'EMAIL_INVALID');
  const pass = await getPass(ctx.env.DB, input.passId);
  if (!pass) throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  const binding = await bindPass(input.expected);
  if (binding.passId !== input.passId || !matchesPass(pass, binding))
    throw new ConflictError(
      'The pass changed. Review the recipient and try again.',
      'DELIVERY_STALE',
    );
  const requestAuthorities = authorityActors(input.authority, input.additionalAuthority);
  if (input.additionalAuthority && !input.authority) throw new ForbiddenError();
  if (requestAuthorities.some((a) => !authorityMayQueue(a, pass))) throw new ForbiddenError();
  const now = ctx.clock.now();
  const actors: QueueActors = input.queuedFor
    ? // `queuedFor` is the issuance scheduler only: the reviewed request-context site (resume on the
      // creating request, authority-epochs.md 1.2.1).
      { deferred: input.queuedFor, allowRequestContext: true as const }
    : requestAuthorities.length > 0
      ? { request: requestAuthorities }
      : { deferred: [await systemActor(ctx.env.DB, pass.orgId)] };
  const named: DeliveryActor[] =
    'request' in actors
      ? await Promise.all(actors.request.map((a) => captureActor(ctx.env.DB, a)))
      : actors.deferred;
  const [actor, also] = named;
  if (!actor) throw new ForbiddenError();
  const intent = {
    format: 1,
    to,
    attach: input.attach,
    pass: binding,
    actor,
    ...(also ? { also } : {}),
    ...(input.issuanceIntentId ? { issuanceId: input.issuanceIntentId } : {}),
  };
  const recipient = (await sha256Hex(`pass-email:${to.toLowerCase()}`)).slice(0, 32);
  const outboxId = ctx.ids.id();
  const result = await insertIssuedPassEmail(ctx, {
    id: outboxId,
    pass,
    actors,
    ...(input.connection ? { connection: input.connection } : {}),
    ...(input.issuanceIntentId ? { issuancePassId: input.issuanceIntentId } : {}),
    ...(input.auditEntry ? { audit: queuedAudit(input.auditEntry, outboxId) } : {}),
    payload: { to, attach: input.attach, intent },
    now,
    rate: {
      recipientKey: `pass-email:${pass.mode}:to:${recipient}`,
      orgKey: `pass-email:${pass.mode}:org:${pass.orgId}`,
      recipientWindow: now - (now % HOUR),
      orgWindow: now - (now % DAY),
      recipientCap: EMAIL_RECIPIENT_HOURLY_CAP,
      orgCap: EMAIL_ORG_DAILY_CAP,
    },
  });
  if (result === 'org')
    throw new ForbiddenError(
      'Organization access changed. Reload and retry.',
      'ORG_ACCESS_CHANGED',
    );
  if (result === 'denied') throw new ForbiddenError();
  if (result === 'stale')
    throw new ConflictError(
      'The pass changed. Review the recipient and try again.',
      'DELIVERY_STALE',
    );
  if (result === 'limited')
    throw new AppError('EMAIL_RATE_LIMITED', 429, 'Too many pass emails. Try again later.', {
      headers: { 'retry-after': '3600' },
    });
  if (input.schedule !== false) ctx.waitUntil(dispatchSafely(ctx, { passId: pass.id }));
  return { outboxId };
}
