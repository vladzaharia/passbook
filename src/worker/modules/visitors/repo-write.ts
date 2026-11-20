import { type Grant, grant } from '../../platform/authority.ts';
import { exactlyOne } from '../../platform/authority-checks.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { grantedAudit } from '../audit/repo-granted.ts';
import { endBinding } from '../nfc/repo-tags-write.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { capabilityChecks, tenantPrincipal } from '../passes/repo-authority.ts';
import type { ScanActor } from '../scan/guard.ts';
import type { ScanPassFacts } from '../scan/scan-pass-checks.ts';
import { scanWriteGrant } from '../scan/scan-write-grant.ts';

type Authority = TenantPassWrite;

const who = (a: Authority) =>
  a.kind === 'session'
    ? ({ type: 'user', id: a.userId, key: `u:${a.userId}` } as const)
    : ({ type: 'api_key', id: a.keyId, key: `k:${a.keyId}` } as const);

const TABLES = ['visitors'] as const;
const CODES = { lineage: 'VISITOR_CHANGED', stale: 'VISITOR_CHANGED' } as const;

export interface NewVisitorRow {
  id: string;
  passId: string;
  name: string;
  hostName: string;
  hostEmail: string;
  windowFrom: number;
  windowUntil: number;
  note: string | null;
}

function tenantGrant(
  ctx: ServiceContext,
  purpose: 'create' | 'cancel' | 'out',
  a: Authority,
  passId: string,
): Grant {
  return grant(ctx, {
    purpose: `org_mode.visitors.${purpose}`,
    target: passId,
    principal: tenantPrincipal(a),
    checks: [...capabilityChecks(a), exactlyOne('passes', { id: passId })],
    codes: CODES,
    tables: [...TABLES],
  });
}

/** The visit row for a pass the same session just issued; the audit row commits with it. */
export function createVisitorGrant(ctx: ServiceContext, a: Authority, v: NewVisitorRow): Grant {
  const g = tenantGrant(ctx, 'create', a, v.passId);
  g.insertSelect(
    'visitors',
    [
      'id',
      'pass_id',
      'name',
      'host_name',
      'host_email',
      'window_from',
      'window_until',
      'note',
      'created_by',
      'created_at',
    ],
    [
      v.id,
      v.passId,
      v.name,
      v.hostName,
      v.hostEmail,
      v.windowFrom,
      v.windowUntil,
      v.note,
      who(a).key,
      ctx.clock.now(),
    ],
  );
  grantedAudit(g, ctx, {
    orgId: a.orgId,
    actorType: who(a).type,
    actorId: who(a).id,
    action: 'visitor.create',
    targetType: 'pass',
    targetId: v.passId,
  });
  return g;
}

export function cancelVisitorGrant(
  ctx: ServiceContext,
  a: Authority,
  v: { id: string; passId: string },
): Grant {
  const g = tenantGrant(ctx, 'cancel', a, v.passId);
  g.update('visitors', {
    set: { cancelled_at: ctx.clock.now() },
    where: { id: v.id, cancelled_at: null },
    require: 'one',
  });
  grantedAudit(g, ctx, {
    orgId: a.orgId,
    actorType: who(a).type,
    actorId: who(a).id,
    action: 'visitor.cancel',
    targetType: 'pass',
    targetId: v.passId,
  });
  return g;
}

/** The console checks a visitor out. Returns the grant to commit. */
export function consoleOutGrant(
  ctx: ServiceContext,
  a: Authority,
  v: { id: string; passId: string },
): Grant {
  const g = tenantGrant(ctx, 'out', a, v.passId);
  g.update('visitors', {
    set: { left_at: ctx.clock.now(), left_by: who(a).key },
    where: { id: v.id, left_at: null },
    require: 'one',
  });
  grantedAudit(g, ctx, {
    orgId: a.orgId,
    actorType: who(a).type,
    actorId: who(a).id,
    action: 'visitor.out',
    targetType: 'pass',
    targetId: v.passId,
    detail: { via: a.kind === 'session' ? 'console' : 'api' },
  });
  return g;
}

/** The desk checks a visitor out: the scanner's own grant, so a paused or retired device is refused. */
export function deskOutGrant(
  ctx: ServiceContext,
  actor: ScanActor,
  v: { id: string; passId: string },
  facts: ScanPassFacts,
): Grant {
  const now = ctx.clock.now();
  const g = scanWriteGrant(ctx, actor, {
    purpose: 'org_mode.scan.visit_out',
    now,
    pausedSession: true,
    pass: { id: v.passId, facts },
    tables: [...TABLES],
  });
  g.update('visitors', {
    set: { left_at: now, left_by: actor.actorKey },
    where: { id: v.id, left_at: null },
    require: 'one',
  });
  grantedAudit(g, ctx, {
    orgId: actor.orgId,
    actorType: actor.actor.type,
    actorId: actor.actor.id,
    action: 'visitor.out',
    targetType: 'pass',
    targetId: v.passId,
    detail: { via: actor.principal === 'admin' ? 'console' : 'scanner' },
  });
  return g;
}

/** Ends tag bindings for an offboarded person; `lost` also marks the tags reported lost. */
export function offboardTagsGrant(
  ctx: ServiceContext,
  a: Authority,
  orgId: string,
  bindings: { id: string; tagId: string }[],
  lost: boolean,
): Grant {
  const g = grant(ctx, {
    purpose: 'org_mode.nfc.tag.offboard',
    principal: tenantPrincipal(a),
    checks: capabilityChecks(a),
    codes: CODES,
    tables: ['nfc_tags', 'tag_bindings'],
  });
  const now = ctx.clock.now();
  for (const b of bindings) {
    endBinding(g, b, 'offboard', { type: 'user', id: who(a).key }, now);
    if (lost)
      g.update('nfc_tags', {
        set: { lost_at: now, lost_by: who(a).key },
        where: { id: b.tagId, lost_at: null },
      });
  }
  grantedAudit(g, ctx, {
    orgId,
    actorType: who(a).type,
    actorId: who(a).id,
    action: 'tag.offboard',
    targetType: 'org',
    targetId: orgId,
    detail: { tags: bindings.length, lost },
  });
  return g;
}
