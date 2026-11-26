import type { z } from 'zod';
import type {
  OperationDto,
  OperationListQuerySchema,
  OperationStep,
} from '../../../shared/contracts/operations.ts';
import type { AuthContext } from '../../platform/auth.ts';
import { classifyD1Error } from '../../platform/db.ts';
import { AppError, ForbiddenError, NotFoundError, ValidationError } from '../../platform/errors.ts';
import { principalOf } from '../../platform/idempotency.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { orgFenceFor, platformFenceFor, readFenceFor, starterFenceFor } from './authz.ts';
import { parseSteps, toDto } from './dto.ts';
import { sendOperationRun } from './jobs.ts';
import { progressOf } from './progress.ts';
import { kindOf, orgKinds, runnerOf } from './registry.ts';
import { activeByDedupe, type OperationRow, rowById } from './repo.ts';
import type { Fence } from './repo-fence.ts';
import { getFenced, listFenced } from './repo-read.ts';
import { finish, markCancel, resetForRetry } from './repo-write.ts';

type Query = z.infer<typeof OperationListQuerySchema>;

const notFound = () => new NotFoundError('Operation not found.', 'OPERATION_NOT_FOUND');

/** One operation the caller may read. Unknown and unreadable are the same 404. */
export async function getOperation(
  ctx: ServiceContext,
  auth: AuthContext,
  id: string,
): Promise<OperationDto> {
  return toDto((await readable(ctx, auth, id)).row);
}

async function readable(
  ctx: ServiceContext,
  auth: AuthContext,
  id: string,
  capability: 'read' | 'write' = 'read',
): Promise<{ row: OperationRow; fence: Fence }> {
  const known = await rowById(ctx.env.DB, id);
  if (!known) throw notFound();
  // Reads first: a caller who cannot read it must not learn that it exists, even to be told 403.
  const readFence = await readFenceFor(ctx, auth, known, 'read');
  const row = readFence ? await getFenced(ctx.env.DB, readFence, id) : null;
  if (!row || !readFence) throw notFound();
  if (capability === 'read') return { row, fence: readFence };
  const writeFence = await readFenceFor(ctx, auth, known, 'write');
  if (!writeFence || !(await getFenced(ctx.env.DB, writeFence, id))) throw new ForbiddenError();
  return { row, fence: writeFence };
}

function decodeCursor(cursor: string | undefined): { createdAt: number; id: string } | null {
  if (!cursor) return null;
  const [at, ...rest] = cursor.split('.');
  const createdAt = Number(at);
  const id = rest.join('.');
  if (!Number.isSafeInteger(createdAt) || !id)
    throw new ValidationError('Invalid cursor.', [], 'INVALID_CURSOR');
  return { createdAt, id };
}

/** Org operations of an org the caller may read, one query per read capability the kinds need. */
async function orgFences(
  ctx: ServiceContext,
  auth: AuthContext,
  orgId: string | null,
): Promise<{ fence: Fence; kinds: string[] }[]> {
  if (!orgId) return [];
  const byCapability = new Map<string, string[]>();
  for (const def of orgKinds())
    byCapability.set(def.read as string, [
      ...(byCapability.get(def.read as string) ?? []),
      def.kind,
    ]);
  const out: { fence: Fence; kinds: string[] }[] = [];
  for (const [capability, kinds] of byCapability) {
    const fence = await orgFenceFor(ctx, auth, orgId, capability as never);
    if (fence) out.push({ fence, kinds });
  }
  return out;
}

/** The caller's operations, newest first: started by them, in an org they read, or platform-wide for admins. */
export async function listOperations(
  ctx: ServiceContext,
  auth: AuthContext,
  query: Query,
): Promise<{ items: OperationDto[]; nextCursor: string | null }> {
  const target = query.target
    ? {
        type: query.target.split(':')[0] ?? '',
        id: query.target.slice(query.target.indexOf(':') + 1),
      }
    : null;
  const orgId = query.orgId ?? (auth.kind === 'api_key' ? auth.orgId : null);
  const actor =
    query.mine === true && auth.kind !== 'scanner'
      ? auth.kind === 'session'
        ? ({ type: 'user', id: auth.userId } as const)
        : ({ type: 'api_key', id: auth.keyId } as const)
      : null;
  const base = {
    active: query.active === true,
    kind: query.kind ?? null,
    target,
    after: decodeCursor(query.cursor),
    limit: query.limit + 1,
  };
  const fences: { fence: Fence; kinds: string[] | null }[] = [];
  const starter = starterFenceFor(ctx, auth);
  if (starter) fences.push({ fence: starter, kinds: null });
  const platform = platformFenceFor(ctx, auth);
  if (platform) fences.push({ fence: platform, kinds: null });
  for (const org of await orgFences(ctx, auth, orgId)) fences.push(org);
  const rows: OperationRow[] = [];
  for (const { fence, kinds } of fences)
    rows.push(...(await listFenced(ctx.env.DB, fence, { ...base, actor, kinds })));
  rows.sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : -1));
  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  return {
    items: page.map(toDto),
    nextCursor: rows.length > query.limit && last ? `${last.created_at}.${last.id}` : null,
  };
}

function auditActor(auth: AuthContext) {
  if (auth.kind === 'session') return { actorType: 'user', actorId: auth.userId } as const;
  if (auth.kind === 'api_key') return { actorType: 'api_key', actorId: auth.keyId } as const;
  return { actorType: 'system', actorId: null } as const;
}

/** Stops it: a queued operation at once, a running one at the runner's next safe boundary. */
export async function cancelOperation(
  ctx: ServiceContext,
  auth: AuthContext,
  id: string,
): Promise<OperationDto> {
  const { row } = await readable(ctx, auth, id, 'write');
  const dto = toDto(row);
  if (!dto.cancelable) {
    // A second request while the stop is pending answers the same operation.
    if (dto.cancelRequested) return dto;
    throw new AppError(
      'OPERATION_NOT_CANCELABLE',
      409,
      'This cannot be stopped. Wait for it to finish.',
    );
  }
  const now = ctx.clock.now();
  const stopped =
    row.status === 'queued' &&
    (await finish(ctx.env.DB, {
      id,
      attempt: row.attempt,
      now,
      status: 'cancelled',
      steps: JSON.stringify(
        dto.steps.map(
          (s): OperationStep => (s.state === 'pending' ? { ...s, state: 'skipped' } : s),
        ),
      ),
      stepKey: row.step_key,
      error: null,
      result: null,
      expiresAt: row.audience === 'starter' ? null : now + 7 * 86_400_000,
    }));
  if (!stopped) await markCancel(ctx.env.DB, id, now);
  const fresh = toDto((await rowById(ctx.env.DB, id)) ?? row);
  await runnerOf(row.kind)?.cancel?.(ctx, fresh);
  await recordAudit(ctx, {
    orgId: row.org_id,
    ...auditActor(auth),
    action: 'operation.cancelled',
    targetType: 'operation',
    targetId: id,
    detail: { kind: row.kind },
  });
  return fresh;
}

/** Steps that are done stay done; the failed step goes back to pending. */
function stepsForRetry(steps: OperationStep[]): OperationStep[] {
  return steps.map((s) =>
    s.state === 'failed'
      ? {
          ...s,
          state: 'pending',
          startedAt: null,
          finishedAt: null,
          detail: null,
          until: null,
          waitingReason: null,
        }
      : s,
  );
}

const notRetryable = () => new AppError('OPERATION_NOT_RETRYABLE', 409, 'This cannot be retried.');

/**
 * Retries a failed operation under the same id with the next attempt. The kind's own hook reruns the start's
 * checks, so a retry is never an authorization shortcut. A repeat with the same `Idempotency-Key` answers the
 * operation the first one retried instead of failing.
 */
export async function retryOperation(
  ctx: ServiceContext,
  auth: AuthContext,
  id: string,
  idempotencyKey?: string,
): Promise<OperationDto> {
  const { row } = await readable(ctx, auth, id, 'write');
  // The key is kept as a hash on the row, per principal: a repeat of the retry it started answers the operation.
  const retryKey =
    idempotencyKey === undefined ? null : await sha256Hex(`${principalOf(auth)}:${idempotencyKey}`);
  if (retryKey !== null && row.retry_key === retryKey) return toDto(row);
  const def = kindOf(row.kind);
  const runner = runnerOf(row.kind);
  if (
    row.status !== 'failed' ||
    row.error_retryable !== 1 ||
    !def?.retry ||
    !(runner?.retry || runner?.run)
  )
    throw notRetryable();
  const now = ctx.clock.now();
  let reset: boolean;
  try {
    reset = await resetForRetry(ctx.env.DB, {
      id,
      attempt: row.attempt,
      now,
      steps: JSON.stringify(stepsForRetry(parseSteps(row.steps))),
      stepKey: null,
      retryKey,
    });
  } catch (error) {
    if (classifyD1Error(error)?.kind !== 'unique') throw error;
    const active = row.dedupe_key ? await activeByDedupe(ctx.env.DB, row.dedupe_key) : null;
    throw new AppError('OPERATION_RUNNING', 409, 'This is already running.', {
      operationId: active?.id ?? id,
    });
  }
  if (!reset) throw notRetryable();
  const next = row.attempt + 1;
  const fresh = toDto((await rowById(ctx.env.DB, id)) as OperationRow);
  try {
    if (runner.retry) await runner.retry(ctx, fresh, auth);
    else await sendOperationRun(ctx, id, next);
  } catch (error) {
    await progressOf(ctx, id, next).fail(error);
    throw error;
  }
  await recordAudit(ctx, {
    orgId: row.org_id,
    ...auditActor(auth),
    action: 'operation.retried',
    targetType: 'operation',
    targetId: id,
    detail: { kind: row.kind, attempt: next },
  });
  return toDto((await rowById(ctx.env.DB, id)) as OperationRow);
}

/** Whether stopping or retrying this operation needs a recent sign-in. Unknown ids need none: the route 404s. */
export async function needsStepUp(ctx: ServiceContext, id: string): Promise<boolean> {
  const row = await rowById(ctx.env.DB, id);
  return row ? (kindOf(row.kind)?.stepUp ?? false) : false;
}
