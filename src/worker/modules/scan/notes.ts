import type { z } from 'zod';
import {
  NOTE_DEVICE_CAP,
  PASS_NOTE_CAP,
  type PassNote,
  type PassNoteEditSchema,
  type PassNoteRequestSchema,
  type PassNotes,
} from '../../../shared/contracts/scan-history.ts';
import { rowIs } from '../../platform/authority-checks.ts';
import { exists } from '../../platform/authority-cond.ts';
import { classifyD1Error } from '../../platform/db.ts';
import { ConflictError, ForbiddenError, NotFoundError } from '../../platform/errors.ts';
import { enforceRateLimit } from '../../platform/rate-limit.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { auditStmt } from '../audit/repo.ts';
import { grantedAudit } from '../audit/repo-granted.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { isPassHeld } from '../retention/holds.ts';
import type { ScanActor } from './actor.ts';
import { isManager, mayReadNotes, mayWriteNotes, passInScope } from './history-scope.ts';
import {
  deviceNoteCount,
  deviceUnderCap,
  type NoteRow,
  noteById,
  noteByKey,
  readNotes,
  underCap,
} from './repo-notes.ts';
import { scanReadAuthority } from './repo-read-authority.ts';
import { HISTORY_READ } from './repo-scan-history.ts';
import { scanWriteGrant } from './scan-write-grant.ts';
import { staleScanRead } from './stale-read.ts';

const DAY = 86_400_000;

/** Written by this person: their staff id, else (no sign-in) this device. */
function ownOf(actor: ScanActor, row: NoteRow): boolean {
  if (actor.staff) return row.author_staff_id === actor.staff.id;
  return row.author_staff_id === null && row.scanner_id === (actor.scanner?.id ?? null);
}

const passIs = (passId: string, pass: Awaited<ReturnType<typeof passFor>>) =>
  rowIs(
    'passes',
    passId,
    {
      template_id: pass.templateId,
      credential_generation: pass.credentialGeneration,
      deleted_at: null,
      removed_at: null,
    },
    'lineage',
  );

const noteOf = (actor: ScanActor, row: NoteRow): PassNote => ({
  id: row.id,
  at: row.created_at,
  body: row.body,
  by: row.author_name,
  own: ownOf(actor, row),
  edited: row.edited_at !== null,
});

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
  if (!mayReadNotes(actor, ctx.clock.now()))
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
    generation: pass.credentialGeneration,
    limit: PASS_NOTE_CAP,
  });
  if (!read.authorized) throw await staleScanRead(ctx, actor);
  await auditStmt(ctx.env.DB, ctx, {
    orgId: actor.orgId,
    actorType: actor.actor.type,
    actorId: actor.actor.id,
    action: 'scan.note.read',
    targetType: 'pass',
    targetId: passId,
    detail: { count: read.rows.length },
  }).run();
  return { items: read.rows.map((row) => noteOf(actor, row)) };
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
  if (!scanner || !mayWriteNotes(actor, ctx.clock.now(), false))
    throw new ForbiddenError('Only Desk staff can add notes.', 'NOTE_ROLE');
  await enforceRateLimit(ctx.env, 'RL_SCAN_LOOKUP', `note:${scanner.id}`);
  const pass = await passFor(ctx, actor, passId);
  const scope = {
    orgId: actor.orgId,
    mode: actor.mode,
    passId,
    generation: pass.credentialGeneration,
  };
  const earlier = await noteByKey(ctx.env.DB, scope, input.idempotencyKey);
  if (earlier) return noteOf(actor, earlier);
  const now = ctx.clock.now();
  const id = ctx.ids.ordered(now);
  const g = scanWriteGrant(ctx, actor, {
    purpose: 'org_mode.scan.note',
    now,
    templateId: pass.templateId,
    tables: ['pass_notes'],
    codes: { lineage: 'SCAN_PASS_CHANGED' },
    checks: [passIs(passId, pass)],
  });
  const inserted = g.insertSelect(
    'pass_notes',
    [
      'id',
      'pass_id',
      'credential_generation',
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
      pass.credentialGeneration,
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
          credential_generation: pass.credentialGeneration,
          deleted_at: null,
          removed_at: null,
          test_data_quarantined: 0,
        }),
        underCap(passId),
        deviceUnderCap(passId, scanner.id, now - DAY, NOTE_DEVICE_CAP),
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
    return noteOf(actor, twin);
  }
  if (!(results[g.indexOf(inserted)]?.results ?? []).length) {
    // The pass moved or went (not found); else this device or the pass is at its cap.
    await passFor(ctx, actor, passId);
    const mine = await deviceNoteCount(ctx.env.DB, passId, scanner.id, now - DAY);
    if (mine >= NOTE_DEVICE_CAP)
      throw new ConflictError(
        'This device has added all it can to this person today.',
        'NOTE_DEVICE_CAP',
      );
    throw new ConflictError('This pass has all the notes it can hold.', 'NOTE_CAP');
  }
  const row = await noteById(ctx.env.DB, scope, id);
  if (!row) throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  return noteOf(actor, row);
}

/** The where of a change: this note on this pass and holder, and for anyone below Manager, theirs. */
function changeWhere(actor: ScanActor, passId: string, noteId: string, generation: number) {
  const mine = isManager(actor)
    ? {}
    : actor.staff
      ? { author_staff_id: actor.staff.id }
      : { author_staff_id: null, scanner_id: actor.scanner?.id ?? null };
  return { id: noteId, pass_id: passId, credential_generation: generation, ...mine };
}

async function changeGrant(ctx: ServiceContext, actor: ScanActor, passId: string, now: number) {
  if (!mayWriteNotes(actor, now, true))
    throw new ForbiddenError('Only the author or a manager can change a note.', 'NOTE_ROLE');
  await enforceRateLimit(ctx.env, 'RL_SCAN_LOOKUP', `note:${actor.scanner?.id ?? actor.actorKey}`);
  const pass = await passFor(ctx, actor, passId);
  // Edits and deletes destroy text a hold preserves; adds do not, so they stay open.
  if (await isPassHeld(ctx, actor.orgId, passId))
    throw new ConflictError('This pass is on hold, so its notes cannot change.', 'NOTE_HELD');
  const g = scanWriteGrant(ctx, actor, {
    purpose: 'org_mode.scan.note',
    now,
    templateId: pass.templateId,
    tables: ['pass_notes'],
    codes: { lineage: 'SCAN_PASS_CHANGED' },
    checks: [passIs(passId, pass)],
  });
  return { g, pass };
}

const missing = () => new NotFoundError('Note not found.', 'NOTE_NOT_FOUND');

/** `PATCH /scan/passes/{id}/notes/{noteId}`: the author, or a Manager. The audit row has the length, not the text. */
export async function editNote(
  ctx: ServiceContext,
  actor: ScanActor,
  passId: string,
  noteId: string,
  input: z.infer<typeof PassNoteEditSchema>,
): Promise<PassNote> {
  const now = ctx.clock.now();
  const { g, pass } = await changeGrant(ctx, actor, passId, now);
  const changed = g.update('pass_notes', {
    set: { body: input.body, edited_at: now },
    where: changeWhere(actor, passId, noteId, pass.credentialGeneration),
    returning: ['id'],
  });
  grantedAudit(
    g,
    ctx,
    {
      orgId: actor.orgId,
      actorType: actor.actor.type,
      actorId: actor.actor.id,
      action: 'scan.note.edit',
      targetType: 'pass',
      targetId: passId,
      detail: { via: actor.scanner ? 'scanner' : 'console', chars: input.body.length },
    },
    [exists('pass_notes', { id: noteId, edited_at: now })],
  );
  const results = await g.commit();
  if (!(results[g.indexOf(changed)]?.results ?? []).length) throw missing();
  const row = await noteById(
    ctx.env.DB,
    { orgId: actor.orgId, mode: actor.mode, passId, generation: pass.credentialGeneration },
    noteId,
  );
  if (!row) throw missing();
  return noteOf(actor, row);
}

/** `DELETE /scan/passes/{id}/notes/{noteId}`: the author, or a Manager. Audited without the text. */
export async function deleteNote(
  ctx: ServiceContext,
  actor: ScanActor,
  passId: string,
  noteId: string,
): Promise<void> {
  const now = ctx.clock.now();
  const { g, pass } = await changeGrant(ctx, actor, passId, now);
  const where = changeWhere(actor, passId, noteId, pass.credentialGeneration);
  // Before the delete: "did the note exist for this person to remove".
  grantedAudit(
    g,
    ctx,
    {
      orgId: actor.orgId,
      actorType: actor.actor.type,
      actorId: actor.actor.id,
      action: 'scan.note.delete',
      targetType: 'pass',
      targetId: passId,
      detail: { via: actor.scanner ? 'scanner' : 'console' },
    },
    [exists('pass_notes', where)],
  );
  const removed = g.delete('pass_notes', { where, returning: ['id'] });
  const results = await g.commit();
  if (!(results[g.indexOf(removed)]?.results ?? []).length) throw missing();
}
