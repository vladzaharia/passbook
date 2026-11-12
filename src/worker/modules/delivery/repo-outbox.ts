import type { Json, Mode } from '../../../shared/contracts/common.ts';
import { OrgBrandingSchema } from '../../../shared/contracts/orgs.ts';
import { rowIs } from '../../platform/authority-checks.ts';
import type { GrantCond } from '../../platform/authority-cond.ts';
import { all, first } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { AuditEntry } from '../audit/types.ts';
import type { BundleEmailSnapshot } from '../bundles/email-binding.ts';
import { bundleChecks } from '../bundles/repo-delivery-fence.ts';
import { orgBrandingJson } from '../orgs/repo.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { tenantPassAuthorityParams, tenantPassAuthoritySql } from '../passes/repo-authority.ts';
import {
  addQueueWrites,
  commitQueue,
  type QueueActors,
  type QueueRate,
  type QueueResult,
  queueGrants,
  rateChecks,
  recordQueuedEvent,
} from './repo-email-queue.ts';
import { mapOutbox, type OutboxDbRow, type OutboxRow } from './repo-outbox-map.ts';

export async function getOutbox(db: D1Database, id: string): Promise<OutboxRow | null> {
  const row = await first<OutboxDbRow>(db, 'SELECT * FROM outbox WHERE id = ?', [id]);
  return row ? mapOutbox(row) : null;
}

export async function listOutboxForPass(
  db: D1Database,
  passId: string,
  limit = 20,
): Promise<OutboxRow[]> {
  const rows = await all<OutboxDbRow>(
    db,
    'SELECT * FROM outbox WHERE pass_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
    [passId, limit],
  );
  return rows.map(mapOutbox);
}

/** Tenant listing repeats current authority and binds every outbox row to its actual pass. */
export async function listAuthorizedOutboxForPass(
  db: D1Database,
  passId: string,
  authority: TenantPassWrite,
  now: number,
  limit = 50,
): Promise<OutboxRow[]> {
  if (
    authority.kind === 'session'
      ? authority.capability !== 'passes:read'
      : authority.scope !== 'passes:read'
  )
    return [];
  const rows = await all<OutboxDbRow>(
    db,
    `SELECT ob.* FROM outbox ob JOIN passes p ON p.id = ob.pass_id AND p.org_id = ob.org_id
     WHERE p.id = ? AND p.deleted_at IS NULL AND p.test_data_quarantined = 0
       ${authority.kind === 'api_key' ? 'AND p.mode = ?' : ''}
       AND ${tenantPassAuthoritySql(authority, 'p')}
     ORDER BY ob.created_at DESC, ob.id DESC LIMIT ?`,
    [
      passId,
      ...(authority.kind === 'api_key' ? [authority.mode] : []),
      ...tenantPassAuthorityParams(authority, now),
      limit,
    ],
  );
  return rows.map(mapOutbox);
}

/**
 * The outbox row, both rate counters, the event and an optional audit row are one batch under the
 * caller's grant (an authority, or a job's system actor). The mail exists exactly when the actor,
 * org and pass (and bundle snapshot) held in that transaction.
 */
export async function enqueueAuthorizedEmail(
  ctx: ServiceContext,
  input: {
    orgId: string;
    passId: string;
    mode: Mode;
    payload: Record<string, unknown>;
    event: Record<string, Json>;
    actors: QueueActors;
    bundleSnapshot?: BundleEmailSnapshot;
    outboxId: string;
    rate: QueueRate;
    audit?: { entry: AuditEntry; when?: GrantCond[] };
  },
): Promise<QueueResult> {
  const snapshot = input.bundleSnapshot;
  if (
    snapshot &&
    (snapshot.bundle.org_id !== input.orgId ||
      snapshot.bundle.mode !== input.mode ||
      snapshot.passes[0]?.id !== input.passId ||
      snapshot.positions.length !== snapshot.passes.length)
  )
    return 'stale';
  const checks = [
    rowIs('passes', input.passId, { deleted_at: null, test_data_quarantined: 0 }),
    ...(snapshot ? bundleChecks(snapshot) : []),
    ...rateChecks(input.rate),
  ];
  const grants = queueGrants(ctx, input.actors, {
    orgId: input.orgId,
    mode: input.mode,
    checks,
    target: input.passId,
  });
  const primary = grants[0];
  if (!primary) return 'denied';
  addQueueWrites(primary, ctx, {
    id: input.outboxId,
    passId: input.passId,
    payload: input.payload,
    now: ctx.clock.now(),
    rate: input.rate,
    ...(input.audit ? { audit: input.audit } : {}),
  });
  const result = await commitQueue(ctx, grants);
  if (result === 'queued')
    await recordQueuedEvent(ctx, input.actors, {
      orgId: input.orgId,
      mode: input.mode,
      passId: input.passId,
      outboxId: input.outboxId,
      data: input.event,
    });
  return result;
}

export interface OrgBranding {
  accent?: string;
  supportEmail?: string;
  supportUrl?: string;
  /** The pass logo shows the org's name. */
  logoHasName?: boolean;
}

/** orgs.branding as written by the org form. Invalid JSON reads as empty. */
export async function orgBranding(db: D1Database, orgId: string): Promise<OrgBranding> {
  const branding = await orgBrandingJson(db, orgId);
  if (branding === null) return {};
  const parsed = OrgBrandingSchema.safeParse(JSON.parse(branding));
  return parsed.success ? parsed.data : {};
}
