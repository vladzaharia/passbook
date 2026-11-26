import { IDENTITY_MOVE_COPY as COPY } from '../../../shared/copy/identity-move.ts';
import { notice } from '../../email/org-closed.ts';
import { baseUrl } from '../../platform/env.ts';
import { AppError } from '../../platform/errors.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { isOrgActive } from '../orgs/active.ts';
import { requireApprovedRelease } from '../templates/releases.ts';
import { resolveTemplate } from './builder.ts';
import { createPassRow, stableStringify } from './create.ts';
import { scheduleRequiredIssuanceDelivery } from './create-delivery.ts';
import { depsOf } from './deps.ts';
import { linksOf } from './detail.ts';
import { uniqueExternalIds } from './external-id.ts';
import { carryEdits, messageKey, without } from './identity-move-carry.ts';
import { gone, revokeReplacement, SYSTEM } from './identity-move-revoke.ts';
import { publishPass } from './publish.ts';
import {
  DAY_MS,
  type MoveRow,
  markIssued,
  markNotified,
  moveById,
  moveByNewPass,
  setState,
} from './repo-identity-move.ts';
import {
  arm,
  claimReminder,
  claimVoid,
  dueReminders,
  dueVoids,
  finishVoid,
  firstRegistration,
  reschedule,
  revokedOld,
  unarmed,
  unclaimReminder,
  voidedByMove,
  voidRef,
} from './repo-identity-move-timers.ts';
import { getOrg } from './repo-read-issuance.ts';
import { getPass } from './repo-read-pass.ts';
import { setPassStatus } from './service-status.ts';
import { stampMovePlan } from './stamps-keep.ts';

/** A holder who never adds the replacement gets one reminder this long after it was issued. */
export const REMIND_AFTER_MS = 30 * DAY_MS;
/**
 * One sweep's hold on a void: it covers the edit carry and the void's publish, so it is long enough for a slow
 * one, and a crashed sweep's claim still lapses within minutes.
 */
export const CLAIM_MS = 5 * 60_000;
const BATCH = 50;

/**
 * Makes the replacement. Its id was fixed when the row was planned, so a rerun finds the pass instead of making
 * a second one. A pass the move cannot copy faithfully stays as it is (`kept`).
 */
export async function issueReplacement(
  ctx: ServiceContext,
  row: MoveRow,
): Promise<'issued' | 'kept'> {
  const db = ctx.env.DB;
  const now = () => ctx.clock.now();
  const old = await getPass(db, row.old_pass_id, row.org_id);
  const keep = async (reason: string) => {
    await setState(db, row.id, ['planned'], { state: 'kept', reason }, now());
    return 'kept' as const;
  };
  let made = await getPass(db, row.new_pass_id);
  if (!made) {
    if (gone(old) || !old || old.identityId !== row.from_identity_id) return keep('old_gone');
    const release = await requireApprovedRelease(ctx, old.templateId, old.orgId, 'live', 'apple');
    const template = await resolveTemplate(ctx, old.orgId, old.templateId, release.version);
    if (old.externalId !== null && uniqueExternalIds(template.manifest)) return keep('external_id');
    const plan = await stampMovePlan(
      ctx,
      { orgId: old.orgId, templateId: old.templateId, version: release.version },
      [old.templateVersion],
    );
    made = await createPassRow(ctx, {
      orgId: old.orgId,
      templateId: old.templateId,
      templateVersion: release.version,
      releaseId: release.id,
      releaseGeneration: release.generation,
      identityId: row.to_identity_id,
      input: plan(old).personalization ?? old.personalization,
      holderEmail: old.holderEmail,
      externalId: old.externalId,
      passId: row.new_pass_id,
      sendEmail: old.holderEmail !== null,
      source: 'manual',
      mode: 'live',
      execution: { kind: 'system' },
      actor: SYSTEM,
    });
  } else if (made.orgId !== row.org_id || made.identityId !== row.to_identity_id)
    throw new AppError('IDENTITY_MOVE_CONFLICT', 409, 'The replacement id is taken.');
  // A rerun after the pass was made: the mail intent is durable, so asking again only queues what is missing.
  if (made.holderEmail) await scheduleRequiredIssuanceDelivery(ctx, made.id);
  const at = now();
  // The two sides of the later edit carry: the old pass and the replacement as they stand at the copy.
  const key = old ? await messageKey(ctx, old) : null;
  const copiedInput = stableStringify(old ? without(old.personalization, key) : {});
  await markIssued(db, row.id, {
    copiedHash: await sha256Hex(copiedInput),
    copiedInput,
    madeInput: stableStringify(without(made.personalization, key)),
    emailedAt: made.holderEmail ? at : null,
    remindAt: at + REMIND_AFTER_MS,
    now: at,
  });
  return 'issued';
}

/**
 * Tells the old pass: its message field carries the add link, with a change message, and the update is pushed.
 * A template with no message field cannot be told; the email is then the only notice.
 */
export async function tellOldPass(ctx: ServiceContext, row: MoveRow): Promise<void> {
  const db = ctx.env.DB;
  const old = await getPass(db, row.old_pass_id, row.org_id);
  const made = await getPass(db, row.new_pass_id, row.org_id);
  if (!old || gone(old)) return revokeReplacement(ctx, row);
  if (!made || gone(made)) {
    await setState(db, row.id, ['issued'], { state: 'kept', reason: 'new_gone' }, ctx.clock.now());
    return;
  }
  const key = await messageKey(ctx, old);
  let toldAt: number | null = null;
  if (key !== null) {
    const link = (await linksOf(ctx, made)).publicUrl;
    if (old.personalization[key] !== link)
      await publishPass(ctx, {
        passId: old.id,
        orgScope: row.org_id,
        cause: 'admin',
        source: 'move',
        sourceRef: `tell:${row.id}`,
        actor: SYSTEM,
        notify: true,
        changeText: COPY.changeMessage,
        mutate: (current) => ({ personalization: { ...current.personalization, [key]: link } }),
      });
    toldAt = ctx.clock.now();
  }
  await markNotified(db, row.id, toldAt, ctx.clock.now());
}

/** The Wallet web service saw the replacement register: start the old pass's 24 hours. */
export async function armOnRegister(ctx: ServiceContext, newPassId: string): Promise<void> {
  const db = ctx.env.DB;
  const row = await moveByNewPass(db, newPassId);
  if (!row || !['issued', 'notified', 'kept'].includes(row.state)) return;
  // Only a device that also holds the old pass arms it; another device's add leaves the reminder flow as it is.
  const reg = await firstRegistration(db, newPassId);
  if (reg) await arm(db, row.id, reg, ctx.clock.now());
}

/**
 * Voids the old pass of a row whose time has come. The claim holds only while a current registration 24 hours
 * old exists and the replacement is still active: nothing is voided before the new pass registered, whatever
 * races the timer. A crash after the claim lets it lapse and the next sweep tries again.
 */
export async function voidDue(
  ctx: ServiceContext,
  row: MoveRow,
): Promise<'voided' | 'waiting' | 'disarmed' | 'kept' | 'skipped'> {
  const db = ctx.env.DB;
  const now = ctx.clock.now();
  // A suspended org's passes cannot be written: the row waits, and the next sweep tries again.
  if (!(await isOrgActive(ctx, row.org_id))) return 'skipped';
  if (!(await claimVoid(db, row.id, now, now + CLAIM_MS))) {
    const fresh = await moveById(db, row.id);
    if (fresh?.state !== 'registered') return 'skipped';
    if (fresh.claim_until !== null && fresh.claim_until > now) return 'skipped';
    if (gone(await getPass(db, row.new_pass_id))) {
      await setState(db, row.id, ['registered'], { state: 'kept', reason: 'new_gone' }, now);
      return 'kept';
    }
    return reschedule(db, fresh, now);
  }
  try {
    const old = await getPass(db, row.old_pass_id, row.org_id);
    if (old?.status === 'active' && old.removedAt === null && old.deletedAt === null) {
      await carryEdits(ctx, row, old);
      await setPassStatus(ctx, SYSTEM, old.id, 'voided', row.org_id, undefined, {
        source: 'move',
        sourceRef: voidRef(row.id),
      });
    } else if (!(old && (await voidedByMove(db, row)))) {
      // Someone else revoked the old pass: the replacement is revoked with it.
      await revokeReplacement(ctx, row);
      return 'kept';
    }
    await finishVoid(db, row.id, ctx.clock.now());
    return 'voided';
  } catch (error) {
    await setState(db, row.id, ['registered'], { state: 'registered' }, ctx.clock.now());
    throw error;
  }
}

/** The one reminder, to a holder whose replacement never registered. */
export async function remindDue(ctx: ServiceContext, row: MoveRow): Promise<'sent' | 'skipped'> {
  const db = ctx.env.DB;
  const now = ctx.clock.now();
  const back = row.state === 'issued' ? 'issued' : 'notified';
  const old = await getPass(db, row.old_pass_id, row.org_id);
  if (!old || gone(old)) {
    await revokeReplacement(ctx, row);
    return 'skipped';
  }
  const made = await getPass(db, row.new_pass_id, row.org_id);
  if (gone(made) || !made) {
    await setState(db, row.id, ['issued', 'notified'], { state: 'kept', reason: 'new_gone' }, now);
    return 'skipped';
  }
  if (!(await isOrgActive(ctx, row.org_id))) return 'skipped';
  if (!(await claimReminder(db, row.id, back, now))) return 'skipped';
  if (!made.holderEmail) return 'skipped';
  try {
    const org = await getOrg(db, row.org_id);
    const url = (await linksOf(ctx, made)).publicUrl;
    const mail = notice(
      baseUrl(ctx.env),
      COPY.reminderSubject,
      COPY.reminderBody(org?.name ?? null, url),
    );
    await depsOf(ctx.env).mailer.send({ to: made.holderEmail, ...mail });
    return 'sent';
  } catch {
    // Provider errors can carry message content: the code and the row are enough. It tries again tomorrow.
    ctx.log.error('identity_move.reminder_failed', {
      code: 'IDENTITY_MOVE_REMINDER',
      moveId: row.id,
    });
    await unclaimReminder(db, row.id, back, now + DAY_MS, ctx.clock.now());
    return 'skipped';
  }
}

/** The minute hook: arms what the register hook missed, voids what is due, sends the reminders that are. */
export async function sweepIdentityMoves(ctx: ServiceContext): Promise<void> {
  const db = ctx.env.DB;
  const now = ctx.clock.now();
  for (const row of await revokedOld(db, now, BATCH))
    try {
      if (await isOrgActive(ctx, row.org_id)) await revokeReplacement(ctx, row);
    } catch (error) {
      ctx.log.error('identity_move.revoke_failed', {
        code: 'IDENTITY_MOVE_REVOKE',
        moveId: row.id,
        error,
      });
    }
  for (const { id, at, device } of await unarmed(db, BATCH)) await arm(db, id, { at, device }, now);
  for (const row of await dueVoids(db, now, BATCH))
    try {
      await voidDue(ctx, row);
    } catch (error) {
      ctx.log.error('identity_move.void_failed', {
        code: 'IDENTITY_MOVE_VOID',
        moveId: row.id,
        error,
      });
    }
  for (const row of await dueReminders(db, now, BATCH))
    try {
      await remindDue(ctx, row);
    } catch (error) {
      ctx.log.error('identity_move.remind_failed', {
        code: 'IDENTITY_MOVE_REMIND',
        moveId: row.id,
        error,
      });
    }
}
