import type { Mode } from '../../../shared/contracts/common.ts';
import type { NewVisitor, Visitor } from '../../../shared/contracts/visitors.ts';
import { VISITOR_COPY } from '../../../shared/copy/visitors.ts';
import { classifyD1Error } from '../../platform/db.ts';
import { ConflictError, NotFoundError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { createPassIdempotent } from '../passes/create.ts';
import { effectiveApiRelease } from '../passes/create-release.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import type { ScopeArg } from '../passes/scope.ts';
import { type Actor, voidPass } from '../passes/service.ts';
import { deriveVisit } from './derive.ts';
import {
  listVisitors as listRows,
  orgTemplates,
  type VisitorRow,
  type VisitTab,
  visitorById,
} from './repo.ts';
import { cancelVisitorGrant, consoleOutGrant, createVisitorGrant } from './repo-write.ts';
import { visitorInput, visitorTemplates } from './template.ts';

const MAX_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export function toVisitor(r: VisitorRow, now: number): Visitor {
  const s = deriveVisit({
    now,
    windowFrom: r.windowFrom,
    windowUntil: r.windowUntil,
    cancelled: r.cancelled,
    arrivedAt: r.arrivedAt,
    lastInAt: r.lastInAt,
    lastOutAt: r.lastOutAt,
  });
  return {
    id: r.id,
    passId: r.passId,
    name: r.name,
    hostName: r.hostName,
    windowFrom: r.windowFrom,
    windowUntil: r.windowUntil,
    note: r.note,
    status: s.status,
    statusAt: s.at,
    autoOut: s.autoOut,
    hasEmail: r.hasEmail,
  };
}

export async function listVisits(
  ctx: ServiceContext,
  orgId: string,
  mode: Mode,
  tab: VisitTab,
  day: { start: number; end: number },
): Promise<Visitor[]> {
  const now = ctx.clock.now();
  return (await listRows(ctx.env.DB, orgId, mode, tab, day)).map((r) => toVisitor(r, now));
}

async function rowOf(ctx: ServiceContext, authority: TenantPassWrite, id: string) {
  const row = await visitorById(ctx.env.DB, authority.orgId, authority.mode, id);
  if (!row) throw new NotFoundError('Visitor not found.', 'VISITOR_NOT_FOUND');
  return row;
}

/**
 * A visitor pass with a host: the pass is issued from the org's guest-plan template (the one named,
 * else the newest), then the visit row is written. A failed visit row voids the pass again.
 */
export async function createVisit(
  ctx: ServiceContext,
  actor: Actor,
  authority: TenantPassWrite,
  body: NewVisitor,
): Promise<Visitor> {
  if (body.windowUntil <= body.windowFrom || body.windowUntil - body.windowFrom > MAX_WINDOW_MS)
    throw new ValidationError('Choose an end after the start, within 14 days.', [
      { path: 'windowUntil', message: 'Choose a later end.' },
    ]);
  const templates = visitorTemplates(await orgTemplates(ctx.env.DB, authority.orgId));
  const template = body.templateId ? templates.find((t) => t.id === body.templateId) : templates[0];
  if (!template) throw new ConflictError(VISITOR_COPY.noTemplate, 'VISITOR_TEMPLATE_MISSING');
  const input = visitorInput(template.manifest, {
    name: body.name,
    hostName: body.hostName,
    windowFrom: body.windowFrom,
    note: body.note ?? null,
    code: `V-${ctx.ids.id().slice(-8).toUpperCase()}`,
  });
  if (!input) throw new ConflictError(VISITOR_COPY.noTemplate, 'VISITOR_TEMPLATE_MISSING');
  const release = await effectiveApiRelease(ctx, {
    orgId: authority.orgId,
    templateId: template.id,
    mode: authority.mode,
  });
  const pass = await createPassIdempotent(
    ctx,
    {
      orgId: authority.orgId,
      templateId: template.id,
      templateVersion: release.version,
      releaseId: release.id,
      releaseGeneration: release.generation,
      input,
      holderEmail: body.email ?? null,
      sendEmail: body.email !== undefined,
      source: 'manual',
      mode: authority.mode,
      execution: { kind: 'tenant', authority },
      actor,
    },
    undefined,
    { serverResolvedRelease: true },
  );
  const id = ctx.ids.id();
  const g = createVisitorGrant(ctx, authority, {
    id,
    passId: pass.id,
    name: body.name,
    hostName: body.hostName,
    hostEmail: body.hostEmail,
    windowFrom: body.windowFrom,
    windowUntil: body.windowUntil,
    note: body.note ?? null,
  });
  try {
    await g.commit();
  } catch (error) {
    // The pass is already issued: void it so no visitor pass exists without its visit.
    await voidPass(ctx, actor, pass.id, scopeOf(authority), authority);
    throw classifyD1Error(error) ? new ConflictError('Try again.', 'VISITOR_CHANGED') : error;
  }
  return toVisitor(await rowOf(ctx, authority, id), ctx.clock.now());
}

const scopeOf = (a: TenantPassWrite): ScopeArg => ({
  orgId: a.orgId,
  mode: a.mode,
  principal: a.kind === 'session' ? 'session' : 'api_key',
});

/** Voids the pass and marks the visit cancelled. A visitor already in cannot be cancelled: check them out. */
export async function cancelVisit(
  ctx: ServiceContext,
  actor: Actor,
  authority: TenantPassWrite,
  id: string,
): Promise<Visitor> {
  const row = await rowOf(ctx, authority, id);
  if (!row.cancelled) {
    if (toVisitor(row, ctx.clock.now()).status === 'in')
      throw new ConflictError('They are in. Check them out first.', 'VISITOR_IN');
    await voidPass(ctx, actor, row.passId, scopeOf(authority), authority);
    await cancelVisitorGrant(ctx, authority, row).commit();
  }
  return toVisitor(await rowOf(ctx, authority, id), ctx.clock.now());
}

/** The console or an API key records the departure; the desk's own route does the same for a scanner. */
export async function checkOutVisit(
  ctx: ServiceContext,
  authority: TenantPassWrite,
  id: string,
): Promise<Visitor> {
  const row = await rowOf(ctx, authority, id);
  const v = toVisitor(row, ctx.clock.now());
  if (v.status !== 'in')
    throw new ConflictError(
      v.status === 'out' ? 'They are already out.' : 'They have not checked in.',
      v.status === 'out' ? 'VISITOR_OUT' : 'VISITOR_NOT_IN',
    );
  await consoleOutGrant(ctx, authority, row).commit();
  return toVisitor(await rowOf(ctx, authority, id), ctx.clock.now());
}
