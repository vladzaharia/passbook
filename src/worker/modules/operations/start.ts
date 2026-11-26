import type { OperationDto, OperationStep } from '../../../shared/contracts/operations.ts';
import { classifyD1Error } from '../../platform/db.ts';
import { AppError } from '../../platform/errors.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { toDto } from './dto.ts';
import { kindOf } from './registry.ts';
import { activeByDedupe, insertOperationStmt, type OperationRow, rowById } from './repo.ts';

/** A runner that holds the lease has this long before a stall check may resend it. */
export const LEASE_MS = 60_000;
const DAY_MS = 86_400_000;
/** Succeeded and cancelled rows keep 7 days, failed 30, a starter's 7 whatever its status (design 2.8). */
export const KEEP_MS = { ended: 7 * DAY_MS, failed: 30 * DAY_MS, starter: 7 * DAY_MS } as const;

export interface StartInput {
  /**
   * A caller-chosen id (the Workflow instance id): a repeat by the same kind, org, mode and actor answers the same
   * operation; any other caller gets 409. Derive it from a client key with `operationIdFor`, never by hand.
   */
  id?: string;
  kind: string;
  /** Org audience: the org and mode the operation belongs to. */
  org?: { orgId: string; mode: 'live' | 'test' };
  target?: { type: string; id: string };
  actor: { type: 'user' | 'api_key' | 'system'; id: string | null };
  /** A starter operation: the starting session (its id hash), the only one that may stop or retry it. */
  session?: string;
  /** What the kind's `dedupe` keys on: one active operation per subject. */
  subject?: Record<string, string>;
  workflowInstanceId?: string;
  /** An in-request run claims the runner lease now (`runInRequest`). */
  lease?: true;
}

/**
 * The stored dedupe key: the kind's own key under its audience and tenant, so two orgs (or users) whose subject
 * values collide never block each other. Kinds meant to share a key (create and delete) share the subject.
 */
export function dedupeKeyOf(input: StartInput): string | null {
  const def = kindOf(input.kind);
  if (!def?.dedupe) return null;
  return `${def.audience}:${input.org?.orgId ?? input.actor.id ?? ''}:${def.dedupe(input.subject ?? {})}`;
}

/** An id for a caller-supplied key: per principal and kind, so two callers never derive the same one. */
export async function operationIdFor(
  principal: string,
  kind: string,
  key: string,
): Promise<string> {
  return (await sha256Hex(`${principal}:${kind}:${key}`)).slice(0, 32);
}

const sameRequest = (row: OperationRow, input: StartInput) =>
  row.kind === input.kind &&
  row.org_id === (input.org?.orgId ?? null) &&
  row.mode === (input.org?.mode ?? null) &&
  row.actor_type === input.actor.type &&
  row.actor_id === input.actor.id;

const reused = () =>
  new AppError('IDEMPOTENCY_KEY_REUSED', 409, 'This key was used for a different request.');

/** The INSERT as a statement, to batch with the domain row it describes. */
export function startOperationStmt(ctx: ServiceContext, input: StartInput) {
  const def = kindOf(input.kind);
  if (!def) throw new AppError('OPERATION_KIND_UNKNOWN', 500, 'Unknown operation kind.');
  if (def.audience === 'org' && !input.org)
    throw new AppError('OPERATION_ORG_REQUIRED', 500, 'An org operation needs an org and mode.');
  const now = ctx.clock.now();
  const id = input.id ?? ctx.ids.id();
  const steps: OperationStep[] = def.steps.map((s) => ({
    key: s.key,
    label: s.label,
    state: 'pending',
    done: null,
    total: null,
    detail: null,
    until: null,
    waitingReason: null,
    group: s.group ?? null,
    startedAt: null,
    finishedAt: null,
  }));
  return {
    id,
    stmt: insertOperationStmt(ctx.env.DB, {
      id,
      kind: def.kind,
      audience: def.audience,
      orgId: def.audience === 'org' ? (input.org?.orgId ?? null) : null,
      mode: def.audience === 'org' ? (input.org?.mode ?? null) : null,
      target: input.target ?? null,
      steps: JSON.stringify(steps),
      actorType: input.actor.type,
      actorId: input.actor.id,
      actorSession: def.audience === 'starter' ? (input.session ?? null) : null,
      dedupeKey: dedupeKeyOf(input),
      workflowInstanceId: input.workflowInstanceId ?? null,
      leaseUntil: input.lease ? now + LEASE_MS : null,
      now,
      expiresAt: def.audience === 'starter' ? now + KEEP_MS.starter : null,
    }),
  };
}

/**
 * Creates the operation, queued. A repeat with the same `id` answers the first operation; a start whose
 * subject already has an active operation answers 409 OPERATION_RUNNING naming it.
 */
export async function startOperation(
  ctx: ServiceContext,
  input: StartInput,
): Promise<OperationDto> {
  const db = ctx.env.DB;
  if (input.id) {
    const existing = await rowById(db, input.id);
    if (existing) {
      if (!sameRequest(existing, input)) throw reused();
      return toDto(existing);
    }
  }
  const { id, stmt } = startOperationStmt(ctx, input);
  try {
    await stmt.run();
  } catch (error) {
    if (classifyD1Error(error)?.kind !== 'unique') throw error;
    const same = input.id ? await rowById(db, id) : null;
    if (same) {
      if (!sameRequest(same, input)) throw reused();
      return toDto(same);
    }
    const key = dedupeKeyOf(input);
    const active = key ? await activeByDedupe(db, key) : null;
    if (!active) throw error;
    // Name the operation only to the person or key that started it: another caller learns no id.
    throw new AppError('OPERATION_RUNNING', 409, 'This is already running.', {
      ...(active.actor_type === input.actor.type && active.actor_id === input.actor.id
        ? { operationId: active.id }
        : {}),
    });
  }
  const row = (await rowById(db, id)) as OperationRow;
  return toDto(row);
}
