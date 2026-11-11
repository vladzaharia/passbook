import { z } from 'zod';
import { type Grant, grant, jobGrant } from '../../platform/authority.ts';
import type { Check } from '../../platform/authority-checks.ts';
import type { Principal } from '../../platform/authority-principal.ts';
import { first } from '../../platform/db.ts';
import type { DenialOptions } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { tenantOrgUpdatedAt } from '../passes/repo-authority.ts';

/**
 * Who a queued email acts for. Captured when the work is queued; checked again when it runs
 * (Rule 4): the membership or key must still be live and the org's `access_revision` unchanged.
 * The initiating session is never part of it, so sign-out and idle expiry do not cancel mail.
 */
export const DeliveryActorSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('membership'),
    membershipId: z.string(),
    orgRevision: z.number().int().positive(),
    /** The user's `access_revision` at queue time: a disable-then-enable cycle ends the mail. */
    userRevision: z.number().int().positive().optional(),
    mode: z.enum(['live', 'test']),
  }),
  z.object({
    kind: z.literal('api_key'),
    keyId: z.string(),
    orgRevision: z.number().int().positive(),
    mode: z.enum(['live', 'test']),
    /** The scope the key held for this work; queued mail predating it is a pass write. */
    scope: z.string().default('passes:write'),
    /** Set for a platform (null-org) key: the org this mail names. */
    orgId: z.string().optional(),
  }),
  z.object({ kind: z.literal('system'), orgRevision: z.number().int().positive().optional() }),
]);
export type DeliveryActor = z.infer<typeof DeliveryActorSchema>;

/** The durable actor of an authority; a session's user epoch is passed when already known. */
export function actorOfAuthority(
  authority: TenantPassWrite,
  userRevision?: number | null,
): DeliveryActor {
  return authority.kind === 'session'
    ? {
        kind: 'membership',
        membershipId: authority.membershipId,
        orgRevision: authority.orgUpdatedAt,
        ...(userRevision ? { userRevision } : {}),
        mode: authority.mode,
      }
    : {
        kind: 'api_key',
        keyId: authority.keyId,
        orgRevision: authority.orgUpdatedAt,
        mode: authority.mode,
        scope: authority.scope,
        ...(authority.keyOrgId === null ? { orgId: authority.orgId } : {}),
      };
}

export interface DeliveryGrantInput {
  /** The only tables the grant writes (required when it includes unguarded writes). */
  tables?: readonly string[];
  /** The last segment of the purpose, for example `email_queue` or `email_send`. */
  action: string;
  orgId: string;
  mode: 'live' | 'test';
  checks: Check[];
  target?: string;
  codes?: DenialOptions['codes'];
}

/** Refusals a delivery caller turns into 409 `DELIVERY_STALE` or a plain 403. */
export const DELIVERY_CODES: DenialOptions['codes'] = {
  lineage: 'DELIVERY_STALE',
  stale: 'DELIVERY_STALE',
  config: 'DELIVERY_STALE',
};

/**
 * The grant for a captured actor. A membership or key acts through a `deferred` principal (no
 * session); a system actor needs a queue, cron or workflow context (`jobGrant`).
 */
export function deliveryGrant(
  ctx: ServiceContext,
  actor: DeliveryActor,
  input: DeliveryGrantInput,
): Grant {
  const common = {
    checks: input.checks,
    codes: input.codes ?? DELIVERY_CODES,
    ...(input.tables ? { tables: input.tables } : {}),
    ...(input.target ? { target: input.target } : {}),
  };
  if (actor.kind === 'system')
    return jobGrant(ctx, {
      ...common,
      job: 'delivery',
      purpose: `org_mode.job.delivery_${input.action}`,
      orgId: input.orgId,
      mode: input.mode,
      ...(actor.orgRevision === undefined ? {} : { orgAccessRevision: actor.orgRevision }),
    });
  const principal: Principal =
    actor.kind === 'membership'
      ? {
          kind: 'membership',
          membershipId: actor.membershipId,
          via: 'deferred',
          orgAccessRevision: actor.orgRevision,
          // Work queued without the user's revision is refused, never revived.
          userAccessRevision: actor.userRevision ?? 0,
          // Queued mail outlives the session that queued it by design.
          allowRequestContext: true as const,
          mode: input.mode,
        }
      : {
          kind: 'api_key',
          keyId: actor.keyId,
          scope: actor.scope,
          orgAccessRevision: actor.orgRevision,
          ...(actor.orgId ? { orgId: actor.orgId } : {}),
        };
  return grant(ctx, { ...common, purpose: `org_mode.delivery.${input.action}`, principal });
}

/** A queue, cron or workflow acts for a mail with no principal row; it pins the org revision it saw. */
export async function systemActor(db: D1Database, orgId: string): Promise<DeliveryActor> {
  const orgRevision = await tenantOrgUpdatedAt(db, orgId);
  return orgRevision === null ? { kind: 'system' } : { kind: 'system', orgRevision };
}

/** A live request may queue mail only for its own org and mode, with the operate capability or write scope. */
export function authorityMayQueue(
  a: TenantPassWrite,
  target: { orgId: string; mode: 'live' | 'test' },
): boolean {
  return (
    a.orgId === target.orgId &&
    a.mode === target.mode &&
    (a.kind === 'session' ? a.capability === 'passes:operate' : a.scope === 'passes:write')
  );
}

/**
 * One grant per captured actor (the queuer and, for a two-authority request, the second one), each
 * checked live; the first carries the checks and the writes. Commit them with `grantedBatch`.
 */
export function deliveryGrants(
  ctx: ServiceContext,
  actors: (DeliveryActor | undefined)[],
  input: DeliveryGrantInput,
): Grant[] {
  return actors
    .filter((a): a is DeliveryActor => a !== undefined)
    .map((a, i) => deliveryGrant(ctx, a, i === 0 ? input : { ...input, checks: [] }));
}

/** Captures the actor of a live request, including its user's current `access_revision`. */
export async function captureActor(
  db: D1Database,
  authority: TenantPassWrite,
): Promise<DeliveryActor> {
  if (authority.kind !== 'session') return actorOfAuthority(authority);
  const row = await first<{ r: number }>(
    db,
    'SELECT access_revision AS r FROM users WHERE id = ?',
    [authority.userId],
  );
  return actorOfAuthority(authority, row?.r);
}
