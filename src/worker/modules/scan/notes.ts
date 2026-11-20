import type { z } from 'zod';
import {
  PASS_NOTE_CAP,
  type PassNote,
  type PassNoteRequestSchema,
  type PassNotes,
} from '../../../shared/contracts/scan-history.ts';
import { exists } from '../../platform/authority-cond.ts';
import { classifyD1Error } from '../../platform/db.ts';
import { ConflictError, ForbiddenError, NotFoundError } from '../../platform/errors.ts';
import { enforceRateLimit } from '../../platform/rate-limit.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { grantedAudit } from '../audit/repo-granted.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import type { ScanActor } from './actor.ts';
import { passInScope } from './history-scope.ts';
import { type NoteRow, noteById, noteByKey, readNotes, underCap } from './repo-notes.ts';
import { scanReadAuthority } from './repo-read-authority.ts';
import { HISTORY_READ, historyProjectable, historyReadable } from './repo-scan-history.ts';
import { ROLE_RANK } from './rules.ts';
import { scanWriteGrant } from './scan-write-grant.ts';
import { staleScanRead } from './stale-read.ts';

const noteOf = (row: NoteRow): PassNote => ({
  id: row.id,
  at: row.created_at,
  body: row.body,
  by: row.author_name,
});

/** Notes are staff-only: Desk and above, never a Door, a customer screen or a monitor. */
export const mayReadNotes = (actor: ScanActor): boolean =>
  actor.role !== null &&
  ROLE_RANK[actor.role] >= ROLE_RANK.desk &&
  historyReadable(actor) &&
  historyProjectable(actor);

/** The pass as a missing one when it is not this actor's to see: another org, mode or template scope. */
export async function passFor(ctx: ServiceContext, actor: ScanActor, passId: string) {
  const pass = await getPass(ctx.env.DB, passId, actor.orgId);
  if (
    !pass ||
    pass.orgId !== actor.orgId ||
    pass.mode !== actor.mode ||
    pass.deletedAt !== null ||
    pass.removedAt !== null ||
    pass.testDataQuarantined ||
    !passInScope(actor, pass.templateId)
  )
    throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  return pass;
}

/** `GET /scan/passes/{id}/notes`. */
export async function notesFor(
  ctx: ServiceContext,
  actor: ScanActor,
  passId: string,
): Promise<PassNotes> {
  if (!mayReadNotes(actor))
    throw new ForbiddenError('Only Desk staff can read notes.', 'NOTE_ROLE');
  const pass = await passFor(ctx, actor, passId);
  const auth = scanReadAuthority(actor, {
    now: ctx.clock.now(),
    read: HISTORY_READ,
    templateId: pass.templateId,
  });
  const read = await readNotes(ctx.env.DB, auth, {
    passId,
    templateId: pass.templateId,
    limit: PASS_NOTE_CAP,
  });
  if (!read.authorized) throw await staleScanRead(ctx, actor);
  return { items: read.rows.map(noteOf) };
}

/**
 * `POST /scan/passes/{id}/notes`. Only a paired, non-terminal scan device whose signed-in staff (or own role) is
 * Desk or up writes, on a pass of its own org, mode and template scope. The text is never logged or
 * audited: the audit row says a note was added and how long it was.
 */
export async function addNote(
  ctx: ServiceContext,
  actor: ScanActor,
  passId: string,
  input: z.infer<typeof PassNoteRequestSchema>,
): Promise<PassNote> {
  const scanner = actor.scanner;
  if (actor.principal !== 'scanner' || !scanner || actor.terminal || !mayReadNotes(actor))
    throw new ForbiddenError('Only Desk staff can add notes.', 'NOTE_ROLE');
  await enforceRateLimit(ctx.env, 'RL_SCAN_LOOKUP', `note:${scanner.id}`);
  const pass = await passFor(ctx, actor, passId);
  const scope = { orgId: actor.orgId, mode: actor.mode, passId };
  const earlier = await noteByKey(ctx.env.DB, scope, input.idempotencyKey);
  if (earlier) return noteOf(earlier);
  const now = ctx.clock.now();
  const id = ctx.ids.ordered(now);
  const g = scanWriteGrant(ctx, actor, {
    purpose: 'org_mode.scan.note',
    now,
    templateId: pass.templateId,
    tables: ['pass_notes'],
    codes: { lineage: 'SCAN_PASS_CHANGED' },
  });
  const inserted = g.insertSelect(
    'pass_notes',
    [
      'id',
      'pass_id',
      'body',
      'author_name',
      'author_staff_id',
      'scanner_id',
      'idempotency_key',
      'created_at',
    ],
    [
      id,
      passId,
      input.body,
      actor.staff?.name ?? actor.name,
      actor.staff?.id ?? null,
      scanner.id,
      input.idempotencyKey,
      now,
    ],
    {
      returning: ['id'],
      when: [
        exists('passes', {
          id: passId,
          template_id: pass.templateId,
          deleted_at: null,
          removed_at: null,
          test_data_quarantined: 0,
        }),
        underCap(passId),
      ],
    },
  );
  grantedAudit(
    g,
    ctx,
    {
      orgId: actor.orgId,
      actorType: actor.actor.type,
      actorId: actor.actor.id,
      action: 'scan.note.add',
      targetType: 'pass',
      targetId: passId,
      detail: { via: 'scanner', chars: input.body.length },
    },
    [exists('pass_notes', { id })],
  );
  let results: Awaited<ReturnType<typeof g.commit>>;
  try {
    results = await g.commit();
  } catch (error) {
    // The same tap sent twice at once: the second answers with the first.
    if (classifyD1Error(error)?.kind !== 'unique') throw error;
    const twin = await noteByKey(ctx.env.DB, scope, input.idempotencyKey);
    if (!twin) throw error;
    return noteOf(twin);
  }
  if (!(results[g.indexOf(inserted)]?.results ?? []).length) {
    // The pass moved or went (not found), else it holds all the notes it may.
    await passFor(ctx, actor, passId);
    throw new ConflictError('This pass has all the notes it can hold.', 'NOTE_CAP');
  }
  const row = await noteById(ctx.env.DB, scope, id);
  if (!row) throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  return noteOf(row);
}
