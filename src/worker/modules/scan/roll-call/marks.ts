// Confirming people on a roll call: one mark at a time, each applied or refused on its own.
import type {
  RollCallMarkResult,
  RollCallMarksResponse,
  RollCallStatus,
} from '../../../../shared/contracts/scan-roll-call.ts';
import type { Grant } from '../../../platform/authority.ts';
import { exists, type GrantCond } from '../../../platform/authority-cond.ts';
import { lt } from '../../../platform/authority-expr.ts';
import { AppError, ConflictError } from '../../../platform/errors.ts';
import type { ServiceContext } from '../../../platform/service-context.ts';
import type { Caller } from './caller.ts';
import { nudgeDevices } from './nudge.ts';
import { marksOf, presenceNow, type SnapshotPerson } from './repo.ts';
import { owned } from './service.ts';
import { rollCallView } from './view.ts';

interface MarkWrite {
  id: string;
  passId: string;
  status: RollCallStatus;
  by: string;
  scannerId: string | null;
  at: number;
  person: SnapshotPerson | null;
  exitScan: string | null;
}

/** The mark's row, by (call, pass): the later time wins. `bump` raises the call's revision in a grant of its own. */
function addMark(g: Grant, w: MarkWrite, when: GrantCond[] = [], bump = false): void {
  if (bump) g.update('roll_calls', { inc: ['rev'], where: { id: w.id, ended_at: null }, when });
  g.upsert(
    'roll_call_marks',
    [
      'roll_call_id',
      'pass_id',
      'status',
      'by_name',
      'scanner_id',
      'late',
      'marked_at',
      'exit_scan_id',
    ],
    [
      w.id,
      w.passId,
      w.status,
      w.by,
      w.scannerId,
      w.person ? JSON.stringify(w.person) : null,
      w.at,
      w.exitScan,
    ],
    {
      update: ['status', 'by_name', 'scanner_id', 'marked_at', 'exit_scan_id'],
      where: { marked_at: lt(w.at) },
      when: [exists('roll_calls', { id: w.id, ended_at: null }), ...when],
    },
  );
}

/**
 * Refusals that are about the mark, not the request: the person scanned since, is not on the call, or is
 * unknown, or this desk may not take the Out back. Anything else (capacity, auth, a failed commit, 5xx) is not
 * the mark's fault: the request fails and the device retries the same marks.
 */
export const isMarkRefusal = (error: unknown): error is AppError =>
  error instanceof AppError &&
  (scannedSince(error) ||
    ['SCAN_UNDO_FORBIDDEN', 'SCAN_UNDO_EXPIRED', 'SCAN_NOT_FOUND', 'NOT_INSIDE'].includes(
      error.code,
    ));

/** The undo found the exit no longer the person's last scan: they have scanned since. */
const scannedSince = (error: unknown) =>
  error instanceof AppError &&
  error.status === 409 &&
  ['UNDO_SUPERSEDED', 'SCAN_PASS_CHANGED', 'SCAN_IN_PROGRESS'].includes(error.code);

export interface MarkInput {
  rollCallId: string;
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
): Promise<RollCallMarksResponse> {
  const call = await owned(ctx, c, id);
  if (call.endedAt !== null)
    throw new ConflictError('This roll call has ended.', 'ROLL_CALL_ENDED');
  const now = ctx.clock.now();
  const members = new Set(call.snapshot.map((p) => p.passId));
  const strangers = [...new Set(marks.map((m) => m.passId).filter((p) => !members.has(p)))];
  const late = new Map<string, SnapshotPerson>();
  if (strangers.length > 0) {
    const here = await presenceNow(
      ctx.env.DB,
      c.orgId,
      c.mode,
      strangers,
      call.places.map((p) => p.place),
    );
    const view = await rollCallView(ctx, c, call);
    for (const p of view.people)
      if (p.late && strangers.includes(p.passId))
        late.set(p.passId, { passId: p.passId, place: p.place, since: p.since });
    for (const s of strangers)
      if (!late.has(s) && here.some((r) => r.passId === s))
        late.set(s, {
          passId: s,
          place: here.find((r) => r.passId === s)?.place ?? '',
          since: now,
        });
  }
  // The later mark by time wins. One that wins as Out exits the person, and one that takes it back undoes
  // that exit; either runs the mark's own write inside the exit's or the undo's grant, so they commit together.
  // A mark that cannot be applied is refused on its own and the others go on.
  const held = new Map((await marksOf(ctx.env.DB, c.orgId, c.mode, id)).map((m) => [m.passId, m]));
  const place = new Map([...call.snapshot, ...late.values()].map((p) => [p.passId, p.place]));
  const results: RollCallMarkResult[] = [];
  const g = c.grant(now);
  g.update('roll_calls', { inc: ['rev'], where: { id, ended_at: null } });
  for (const m of [...marks].sort((a, b) => (a.at ?? now) - (b.at ?? now))) {
    const refuse = (code: string) =>
      results.push({ rollCallId: m.rollCallId, passId: m.passId, status: 'refused', code });
    if (m.rollCallId !== id) {
      refuse('ROLL_CALL_MARK_MISMATCH');
      continue;
    }
    const where = place.get(m.passId);
    if (!where) {
      refuse('ROLL_CALL_NOT_LISTED');
      continue;
    }
    const at = Math.min(m.at ?? now, now);
    const prior = held.get(m.passId);
    if (prior && prior.at >= at) {
      results.push({ rollCallId: id, passId: m.passId, status: 'applied' });
      continue;
    }
    const mark = (exitScan: string | null): MarkWrite => ({
      id,
      passId: m.passId,
      status: m.status,
      by: c.by,
      scannerId: c.scannerId,
      at,
      person: late.get(m.passId) ?? null,
      exitScan,
    });
    let exitScan = prior?.exitScanId ?? null;
    let untracked = false;
    try {
      if (m.status === 'out' && !exitScan && c.exit) {
        try {
          const scan = await c.exit(m.passId, where, (eg, scanId, won) =>
            addMark(eg, mark(scanId), [won], true),
          );
          if (scan) exitScan = scan;
          else addMark(g, mark(null));
        } catch (error) {
          // The zone left the session, stopped tracking or the pass is gone: nothing to exit here. The Out is
          // recorded as a confirmation alone, and the desk is told.
          if (!(error instanceof AppError) || error.code !== 'SCAN_MARK_OUT_INVALID') throw error;
          addMark(g, mark(null));
          untracked = true;
        }
      } else if (m.status !== 'out' && exitScan && c.undoExit) {
        await c.undoExit(exitScan, (ug) => addMark(ug, mark(null), [], true));
        exitScan = null;
      } else addMark(g, mark(exitScan));
    } catch (error) {
      if (!isMarkRefusal(error)) throw error;
      refuse(scannedSince(error) ? 'ROLL_CALL_SCANNED_SINCE' : error.code);
      continue;
    }
    results.push({
      rollCallId: id,
      passId: m.passId,
      status: 'applied',
      ...(untracked ? { code: 'ROLL_CALL_OUT_NOT_TRACKED' } : {}),
    });
    held.set(m.passId, {
      passId: m.passId,
      status: m.status,
      by: c.by,
      at,
      late: null,
      exitScanId: exitScan,
    });
  }
  await g.commit();
  const after = await owned(ctx, c, id);
  if (after.endedAt !== null && after.rev === call.rev)
    throw new ConflictError('This roll call has ended.', 'ROLL_CALL_ENDED');
  await nudgeDevices(ctx, c.orgId, c.mode, after);
  return { ...(await rollCallView(ctx, c, after)), results };
}
