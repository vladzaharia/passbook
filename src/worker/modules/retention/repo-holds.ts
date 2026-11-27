import { callerActor, callerPrincipal, type PlatformCaller } from '../../platform/actor.ts';
import { grant } from '../../platform/authority.ts';
import { all, first } from '../../platform/db.ts';
import { ForbiddenError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { capabilityChecks, tenantPrincipal } from '../passes/repo-authority.ts';
import type { SettingsAuthority } from '../settings/repo.ts';
import type { HoldKind } from './policy.ts';

export interface HoldRow {
  id: string;
  orgId: string;
  passId: string | null;
  placedByKind: HoldKind;
  placedBy: string;
  reason: string;
  createdAt: number;
  releasedAt: number | null;
  releasedBy: string | null;
}

interface Raw {
  id: string;
  org_id: string;
  pass_id: string | null;
  placed_by_kind: HoldKind;
  placed_by: string;
  reason: string;
  created_at: number;
  released_at: number | null;
  released_by: string | null;
}

const toRow = (r: Raw): HoldRow => ({
  id: r.id,
  orgId: r.org_id,
  passId: r.pass_id,
  placedByKind: r.placed_by_kind,
  placedBy: r.placed_by,
  reason: r.reason,
  createdAt: r.created_at,
  releasedAt: r.released_at,
  releasedBy: r.released_by,
});

const SELECT = `SELECT id, org_id, pass_id, placed_by_kind, placed_by, reason, created_at, released_at, released_by
  FROM retention_holds`;

export async function holdRow(db: D1Database, orgId: string, id: string): Promise<HoldRow | null> {
  const r = await first<Raw>(db, `${SELECT} WHERE id = ? AND org_id = ?`, [id, orgId]);
  return r ? toRow(r) : null;
}

/** Active holds first, newest first. */
export async function listHoldRows(db: D1Database, orgId: string): Promise<HoldRow[]> {
  const rows = await all<Raw>(
    db,
    `${SELECT} WHERE org_id = ? ORDER BY (released_at IS NOT NULL), created_at DESC, id DESC LIMIT 200`,
    [orgId],
  );
  return rows.map(toRow);
}

/** Any status, closed included. */
export async function orgExists(db: D1Database, orgId: string): Promise<boolean> {
  return (await first(db, 'SELECT 1 AS x FROM orgs WHERE id = ?', [orgId])) !== null;
}

export async function passHeld(db: D1Database, orgId: string, passId: string): Promise<boolean> {
  const r = await first(
    db,
    `SELECT 1 AS x FROM retention_holds
     WHERE org_id = ? AND released_at IS NULL AND (pass_id IS NULL OR pass_id = ?) LIMIT 1`,
    [orgId, passId],
  );
  return r !== null;
}

export async function passInOrg(db: D1Database, orgId: string, passId: string): Promise<boolean> {
  return (
    (await first(db, 'SELECT 1 AS x FROM passes WHERE id = ? AND org_id = ?', [passId, orgId])) !==
    null
  );
}

export type HoldBy =
  | { kind: 'org'; authority: SettingsAuthority }
  /** `user` is the user a `placed_by` column names when `admin` is a key: its creator. */
  | { kind: 'platform'; admin: PlatformCaller; user?: string };

export const holderOf = (by: HoldBy): string => {
  if (by.kind === 'org') return by.authority.userId;
  const user = by.user ?? by.admin.userId;
  if (!user) throw new ForbiddenError();
  return user;
};

/** Who the audit row names: the person, or the key. */
const auditActorOfHold = (by: HoldBy) => {
  if (by.kind === 'org') return { actorType: 'user' as const, actorId: by.authority.userId };
  const actor = callerActor(by.admin);
  return { actorType: actor.type, actorId: actor.id };
};

function holdGrant(ctx: ServiceContext, purpose: 'place' | 'release', orgId: string, by: HoldBy) {
  return by.kind === 'org'
    ? grant(ctx, {
        purpose: `org.retention.hold.${purpose}`,
        principal: tenantPrincipal(by.authority),
        target: orgId,
        checks: capabilityChecks(by.authority),
      })
    : grant(ctx, {
        purpose: `platform.retention.hold.${purpose}`,
        principal: callerPrincipal(by.admin),
        target: orgId,
      });
}

interface Audit {
  action: string;
  targetId: string;
  detail: string;
}

/** One batch: the hold row and its audit row commit together, under the placer's live authority. */
export async function insertHold(
  ctx: ServiceContext,
  by: HoldBy,
  row: { id: string; orgId: string; passId: string | null; reason: string; now: number },
  audit: Audit,
): Promise<void> {
  const g = holdGrant(ctx, 'place', row.orgId, by);
  const cols = ['id', 'pass_id', 'placed_by_kind', 'placed_by', 'reason', 'created_at'];
  const vals = [row.id, row.passId, by.kind, holderOf(by), row.reason, row.now];
  g.insertSelect(
    'retention_holds',
    by.kind === 'platform' ? ['org_id', ...cols] : cols,
    by.kind === 'platform' ? [row.orgId, ...vals] : vals,
  );
  g.audit({
    at: row.now,
    orgId: row.orgId,
    ...auditActorOfHold(by),
    requestId: ctx.requestId ?? null,
    ipPrefix: null,
    targetType: 'retention_hold',
    ...audit,
  });
  await g.commit();
}

/**
 * Releases one active hold. An org grant also pins `placed_by_kind = 'org'`, so it can never release a
 * platform hold even if the service check were bypassed: the batch aborts.
 */
export async function closeHold(
  ctx: ServiceContext,
  by: HoldBy,
  row: { id: string; orgId: string; now: number },
  audit: Audit,
): Promise<void> {
  const g = holdGrant(ctx, 'release', row.orgId, by);
  g.update('retention_holds', {
    set: { released_at: row.now, released_by: holderOf(by) },
    where: {
      id: row.id,
      released_at: null,
      ...(by.kind === 'org' ? { placed_by_kind: 'org' } : {}),
    },
    require: 'one',
  });
  g.audit({
    at: row.now,
    orgId: row.orgId,
    ...auditActorOfHold(by),
    requestId: ctx.requestId ?? null,
    ipPrefix: null,
    targetType: 'retention_hold',
    ...audit,
  });
  await g.commit();
}
