// Roll call (PS-33): freeze Who's in, confirm each person, end. A device and the API run the same rules.
import {
  ROLL_CALL_MAX_PEOPLE,
  type RollCall,
  type RollCallCurrent,
  type RollCallStatus,
} from '../../../../shared/contracts/scan-roll-call.ts';
import { exists } from '../../../platform/authority-cond.ts';
import { lt } from '../../../platform/authority-expr.ts';
import { classifyD1Error } from '../../../platform/db.ts';
import { ConflictError, ForbiddenError, NotFoundError } from '../../../platform/errors.ts';
import type { ServiceContext } from '../../../platform/service-context.ts';
import { grantedAudit } from '../../audit/repo-granted.ts';
import { occupancyZones } from '../occupancy/service.ts';
import type { Caller } from './caller.ts';
import { nudgeDevices } from './nudge.ts';
import {
  type CallRow,
  callById,
  openCall,
  type PlaceInfo,
  presenceNow,
  type SnapshotPerson,
} from './repo.ts';
import { rollCallView } from './view.ts';

const PAGE = 100;

/** Zones that require tap-out count "In now"; the rest count "Tapped in". Events track exits. */
async function placesOf(ctx: ServiceContext, c: Caller): Promise<PlaceInfo[]> {
  const zones = await occupancyZones(ctx.env.DB, c.orgId);
  const enforced = new Set(
    zones.filter((z) => z.occupancy === 'enforce').map((z) => `zone:${z.id}`),
  );
  return (await c.scope()).places.map((p) => ({
    place: p.place,
    name: p.name,
    basis: enforced.has(p.place) || p.place.startsWith('event:') ? 'in_now' : 'tapped_in',
  }));
}

async function freeze(c: Caller): Promise<SnapshotPerson[]> {
  const out: SnapshotPerson[] = [];
  let cursor: string | undefined;
  for (;;) {
    const list = await c.list({ limit: PAGE, ...(cursor ? { cursor } : {}) });
    for (const r of list.items)
      out.push({
        passId: r.passId,
        holder: r.holder,
        plan: r.plan,
        host: r.host,
        place: r.place,
        since: r.since,
      });
    if (out.length > ROLL_CALL_MAX_PEOPLE)
      throw new ConflictError('Too many people inside to freeze a list.', 'ROLL_CALL_TOO_LARGE');
    if (!list.nextCursor) return out;
    cursor = list.nextCursor;
  }
}

/** Starts the scope's roll call, or joins the one already open: other desks join in. */
export async function startRollCall(ctx: ServiceContext, c: Caller): Promise<RollCall> {
  const db = ctx.env.DB;
  const open = await openCall(db, c.orgId, c.mode, c.scopeKey);
  if (open) return rollCallView(ctx, c, open);
  const places = await placesOf(ctx, c);
  if (places.length === 0)
    throw new ConflictError(
      'Nothing is tracked here, so there is no one to call.',
      'ROLL_CALL_NO_PLACES',
    );
  const now = ctx.clock.now();
  const id = ctx.ids.ordered(now);
  const snapshot = await freeze(c);
  const g = c.grant(now);
  g.insertSelect(
    'roll_calls',
    [
      'id',
      'scope_key',
      'places',
      'snapshot',
      'started_by',
      'started_by_id',
      'scanner_id',
      'started_at',
    ],
    [
      id,
      c.scopeKey,
      JSON.stringify(places),
      JSON.stringify(snapshot),
      c.by,
      c.byId,
      c.scannerId,
      now,
    ],
    { returning: ['id'] },
  );
  grantedAudit(
    g,
    ctx,
    {
      orgId: c.orgId,
      actorType: c.actor.type,
      actorId: c.actor.id,
      action: 'rollcall.start',
      targetType: 'roll_call',
      targetId: id,
      detail: { via: c.via, people: snapshot.length, places: places.length },
    },
    [exists('roll_calls', { id })],
  );
  try {
    await g.commit();
  } catch (error) {
    // Two desks started at once: the second joins the first.
    if (classifyD1Error(error)?.kind !== 'unique') throw error;
    const twin = await openCall(db, c.orgId, c.mode, c.scopeKey);
    if (!twin) throw error;
    return rollCallView(ctx, c, twin);
  }
  const call = await callById(db, c.orgId, c.mode, id);
  if (!call) throw new NotFoundError('Roll call not found.', 'ROLL_CALL_NOT_FOUND');
  await nudgeDevices(ctx, c.orgId, c.mode, call);
  return rollCallView(ctx, c, call);
}

export async function currentRollCall(ctx: ServiceContext, c: Caller): Promise<RollCallCurrent> {
  const open = await openCall(ctx.env.DB, c.orgId, c.mode, c.scopeKey);
  return { rollCall: open ? await rollCallView(ctx, c, open) : null };
}

async function owned(ctx: ServiceContext, c: Caller, id: string): Promise<CallRow> {
  const call = await callById(ctx.env.DB, c.orgId, c.mode, id);
  // A device sees only its own session's call; a console or key reaches any call of the org.
  if (!call || (c.via === 'scanner' && call.scopeKey !== c.scopeKey))
    throw new NotFoundError('Roll call not found.', 'ROLL_CALL_NOT_FOUND');
  return call;
}

export async function readRollCall(ctx: ServiceContext, c: Caller, id: string): Promise<RollCall> {
  return rollCallView(ctx, c, await owned(ctx, c, id));
}

export interface MarkInput {
  passId: string;
  status: RollCallStatus;
  at?: number | undefined;
}

/**
 * Confirms people present or out. The later mark by the device's clock wins, whatever order two desks
 * arrive in, so an offline queue merges by time. A person who tapped in after the start can be marked too.
 */
export async function markRollCall(
  ctx: ServiceContext,
  c: Caller,
  id: string,
  marks: readonly MarkInput[],
): Promise<RollCall> {
  const call = await owned(ctx, c, id);
  if (call.endedAt !== null)
    throw new ConflictError('This roll call has ended.', 'ROLL_CALL_ENDED');
  const now = ctx.clock.now();
  const members = new Set(call.snapshot.map((p) => p.passId));
  const strangers = [...new Set(marks.map((m) => m.passId).filter((p) => !members.has(p)))];
  const late = new Map<string, SnapshotPerson>();
  if (strangers.length > 0) {
    const places = call.places.map((p) => p.place);
    const here = await presenceNow(ctx.env.DB, c.orgId, c.mode, strangers, places);
    const view = await rollCallView(ctx, c, call);
    for (const p of view.people)
      if (p.late && strangers.includes(p.passId))
        late.set(p.passId, {
          passId: p.passId,
          holder: p.holder,
          plan: p.plan,
          host: p.host,
          place: p.place,
          since: p.since,
        });
    for (const s of strangers)
      if (!late.has(s) && !here.some((r) => r.passId === s))
        throw new ForbiddenError('That person is not on this roll call.', 'ROLL_CALL_NOT_LISTED');
  }
  const g = c.grant(now);
  g.update('roll_calls', { inc: ['rev'], where: { id, ended_at: null } });
  for (const m of [...marks].sort((a, b) => (a.at ?? now) - (b.at ?? now))) {
    const at = Math.min(m.at ?? now, now);
    const person = late.get(m.passId);
    g.upsert(
      'roll_call_marks',
      ['roll_call_id', 'pass_id', 'status', 'by_name', 'scanner_id', 'late', 'marked_at'],
      [id, m.passId, m.status, c.by, c.scannerId, person ? JSON.stringify(person) : null, at],
      {
        update: ['status', 'by_name', 'scanner_id', 'marked_at'],
        where: { marked_at: lt(at) },
        when: [exists('roll_calls', { id, ended_at: null })],
      },
    );
  }
  await g.commit();
  const after = await owned(ctx, c, id);
  if (after.endedAt !== null && after.rev === call.rev)
    throw new ConflictError('This roll call has ended.', 'ROLL_CALL_ENDED');
  await nudgeDevices(ctx, c.orgId, c.mode, after);
  return rollCallView(ctx, c, after);
}

/** Ends the call and keeps it as a record. Ending twice answers with the record. */
export async function endRollCall(ctx: ServiceContext, c: Caller, id: string): Promise<RollCall> {
  const call = await owned(ctx, c, id);
  if (call.endedAt === null) {
    const now = ctx.clock.now();
    const g = c.grant(now);
    g.update('roll_calls', {
      set: { ended_at: now, ended_by: c.by },
      where: { id, ended_at: null },
      returning: ['id'],
    });
    grantedAudit(
      g,
      ctx,
      {
        orgId: c.orgId,
        actorType: c.actor.type,
        actorId: c.actor.id,
        action: 'rollcall.end',
        targetType: 'roll_call',
        targetId: id,
        detail: { via: c.via },
      },
      [exists('roll_calls', { id, ended_at: now })],
    );
    await g.commit();
  }
  const after = await owned(ctx, c, id);
  await nudgeDevices(ctx, c.orgId, c.mode, after);
  return rollCallView(ctx, c, after);
}
