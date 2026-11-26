import type { z } from 'zod';
import type {
  DriftListSchema,
  IdpCallListSchema,
  IdpStatusSchema,
} from '../../../shared/contracts/idp-access.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { idpClient, idpConfigured } from './client.ts';
import { idpCodeOf } from './errors.ts';
import { needBinding } from './ops-start.ts';
import { openDrift, openDriftCounts } from './repo-drift.ts';
import { breakerOpen } from './repo-scim.ts';
import { lastScimChange } from './repo-user-access.ts';
import { BREAKER_KEY, BREAKER_LATCH_MS } from './scim-effects.ts';
import type { Actor } from './service-roles.ts';

type Status = z.infer<typeof IdpStatusSchema>;

/** Connected, mode, freeze, key expiry, budgets, the last SCIM change and open differences. Hidden data when the binding is absent. */
export async function idpStatus(ctx: ServiceContext): Promise<Status> {
  const db = ctx.env.DB;
  const drift: Record<string, number> = {};
  for (const row of await openDriftCounts(db)) drift[row.kind] = row.n;
  const base = {
    lastScimAt: await lastScimChange(db),
    drift,
    breakerOpen: await breakerOpen(db, BREAKER_KEY, ctx.clock.now(), BREAKER_LATCH_MS),
  };
  if (!idpConfigured(ctx.env))
    return {
      connected: false,
      mode: null,
      frozen: null,
      keyExpiresAt: null,
      problems: [],
      budget: {},
      ...base,
    };
  try {
    const h = await idpClient(ctx.env, ctx.log).health();
    return {
      connected: true,
      mode: h.mode,
      frozen: h.frozen,
      keyExpiresAt: h.keyExpiresAt,
      problems: [...h.unsafe, ...h.warnings],
      budget: h.budget,
      ...base,
    };
  } catch (error) {
    ctx.log.warn('idp.status_failed', { code: idpCodeOf(error) ?? 'IDP_UNAVAILABLE' });
    return {
      connected: false,
      mode: null,
      frozen: null,
      keyExpiresAt: null,
      problems: [],
      budget: {},
      ...base,
    };
  }
}

const DRIFT_LIMIT = 200;
/** The binding answers this many ledger rows at a time. */
const CALLS_PAGE = 1000;

export async function idpDrift(ctx: ServiceContext): Promise<z.infer<typeof DriftListSchema>> {
  const rows = await openDrift(ctx.env.DB, DRIFT_LIMIT);
  return {
    items: rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      target: r.target,
      kind: r.kind,
      foundAt: r.found_at,
    })),
    nextCursor: null,
  };
}

/** Pauses every Polaris ID change. There is no thaw call: the owner lifts it in Polaris ID's binding. */
export async function freezeIdp(
  ctx: ServiceContext,
  actor: Actor,
  reason: string,
): Promise<'frozen' | 'already'> {
  needBinding(ctx);
  // The binding takes a code (its ledger holds no free text); the words the admin typed stay in PassBook's audit log.
  const result = await idpClient(ctx.env, ctx.log).freeze('admin_pause', {
    ref: `freeze-${ctx.requestId ?? ctx.ids.id()}`,
    reason: 'freeze',
    actor: { kind: 'user', id: actor.id },
  });
  if (result === 'frozen')
    await recordAudit(ctx, {
      actorType: actor.type,
      actorId: actor.id,
      action: 'idp.freeze',
      targetType: 'idp',
      targetId: 'binding',
      detail: { reason },
    });
  return result;
}

/** The binding's ledger from `since`, a page at a time. Ids, methods and codes: never a value. */
export async function idpCalls(
  ctx: ServiceContext,
  since: number,
  cursor?: string,
): Promise<z.infer<typeof IdpCallListSchema>> {
  needBinding(ctx);
  const rows = await idpClient(ctx.env, ctx.log).calls(since, cursor ? Number(cursor) : undefined);
  const last = rows.at(-1);
  return {
    items: rows.map((r) => ({
      id: r.id,
      phase: r.phase,
      method: r.method,
      target: r.target,
      actor: r.actor,
      reason: r.reason,
      status: r.status,
      at: r.at,
    })),
    nextCursor: rows.length >= CALLS_PAGE && last ? String(last.id) : null,
  };
}
