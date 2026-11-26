import { IDENTITY_MOVE_COPY as COPY } from '../../../shared/copy/identity-move.ts';
import { notice } from '../../email/org-closed.ts';
import { baseUrl } from '../../platform/env.ts';
import { AppError } from '../../platform/errors.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordPassEvent } from '../events/record.ts';
import { isOrgActive } from '../orgs/active.ts';
import { requireApprovedRelease } from '../templates/releases.ts';
import { createPassRow, stableStringify } from './create.ts';
import { scheduleRequiredIssuanceDelivery } from './create-delivery.ts';
import { depsOf } from './deps.ts';
import { linksOf } from './detail.ts';
import { carryEdits, messageKey, without } from './identity-move-carry.ts';
import { fingerprintOf, recarryState } from './identity-move-recarry.ts';
import { moveVoidCommit } from './identity-move-repoint.ts';
import { gone, revokeReplacement, SYSTEM } from './identity-move-revoke.ts';
import { carryState, stageFiles } from './identity-move-state.ts';
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
import { keptReason } from './repo-identity-move-candidates.ts';
import { readRepoint, readState } from './repo-identity-move-state.ts';
import {
  arm,
  claimReminder,
  claimVoid,
  finishVoid,
  firstRegistration,
  reschedule,
  setWaitReason,
  unclaimReminder,
  voidedByMove,
  voidRef,
} from './repo-identity-move-timers.ts';
import { heldReason } from './repo-identity-move-wallet.ts';
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
  const live = old && !gone(old) && old.identityId === row.from_identity_id ? old : null;
  // The images are copied before the replacement exists: one that is gone keeps the pass where it is.
  const state = live ? await readState(db, live.id) : null;
  const files = live && state ? await stageFiles(ctx, live, row.new_pass_id, state) : null;
  if (!made) {
    if (!live) return keep('old_gone');
    if (!files) return keep('files_missing');
    const release = await requireApprovedRelease(ctx, live.templateId, live.orgId, 'live', 'apple');
    const plan = await stampMovePlan(
      ctx,
      { orgId: live.orgId, templateId: live.templateId, version: release.version },
      [live.templateVersion],
    );
    // The external id moves in the batch that voids the old pass, so no two active passes ever share it.
    made = await createPassRow(ctx, {
      orgId: live.orgId,
      templateId: live.templateId,
      templateVersion: release.version,
      releaseId: release.id,
      releaseGeneration: release.generation,
      identityId: row.to_identity_id,
      input: plan(live).personalization ?? live.personalization,
      holderEmail: live.holderEmail,
      externalId: null,
      passId: row.new_pass_id,
      sendEmail: live.holderEmail !== null,
      source: 'manual',
      mode: 'live',
      execution: { kind: 'system' },
      actor: SYSTEM,
    });
  } else if (made.orgId !== row.org_id || made.identityId !== row.to_identity_id)
    throw new AppError('IDENTITY_MOVE_CONFLICT', 409, 'The replacement id is taken.');
  // What the old pass holds besides its fields goes along; the replacement is signed again with it.
  if (live && state && files && (await carryState(ctx, live, made, state, files)))
    await publishPass(ctx, {
      passId: made.id,
      orgScope: row.org_id,
      cause: 'admin',
      source: 'move',
      sourceRef: `carry:${row.id}`,
      actor: SYSTEM,
      force: true,
      notify: false,
      mutate: () => ({}),
    });
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
    copiedState: JSON.stringify(await fingerprintOf(db, row.old_pass_id)),
    madeState: JSON.stringify(await fingerprintOf(db, made.id)),
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
    // The old pass took on something the move cannot carry since it was planned. A device holds the replacement,
    // so neither pass is voided: both stay live, and the row says why.
    const why = await keptReason(db, row.old_pass_id);
    if (why !== null) {
      await setState(db, row.id, ['registered'], { state: 'kept_both', reason: why }, now);
      ctx.log.info('identity_move.kept_both', { moveId: row.id, reason: why });
      return 'kept';
    }
    // A device holds a wallet copy of the old pass that the replacement lacks: the row waits, with its reason, for
    // the holder to save the new one. At the reminder's deadline it stays as it is, both passes live.
    const held = await heldReason(db, row);
    if (held !== null) {
      if (fresh.remind_at !== null && now >= fresh.remind_at) {
        await setState(db, row.id, ['registered'], { state: 'kept_both', reason: held }, now);
        ctx.log.info('identity_move.kept_both', { moveId: row.id, reason: held });
        return 'kept';
      }
      await setWaitReason(db, row.id, held, now);
      return 'waiting';
    }
    return reschedule(db, fresh, now);
  }
  try {
    const old = await getPass(db, row.old_pass_id, row.org_id);
    if (old?.status === 'active' && old.removedAt === null && old.deletedAt === null) {
      await carryEdits(ctx, row, old);
      await recarryState(ctx, row, old);
      const made = await getPass(db, row.new_pass_id, row.org_id);
      if (!made) throw new AppError('IDENTITY_MOVE_CONFLICT', 409, 'The replacement is gone.');
      await setPassStatus(ctx, SYSTEM, old.id, 'voided', row.org_id, undefined, {
        source: 'move',
        sourceRef: voidRef(row.id),
        // The external id and everything the pass owns move in the void's own batch.
        ...(old.externalId === null ? {} : { externalId: null }),
        commit: moveVoidCommit(ctx, row, { old, made, plan: await readRepoint(db, old.id) }),
      });
    } else if (!(old && (await voidedByMove(db, row)))) {
      // Someone else revoked the old pass: the replacement is revoked with it.
      await revokeReplacement(ctx, row);
      return 'kept';
    }
    if (await finishVoid(db, row.id, ctx.clock.now()))
      await recordPassEvent(ctx, {
        orgId: row.org_id,
        passId: row.old_pass_id,
        mode: row.mode,
        kind: 'pass.replaced',
        actor: SYSTEM,
        data: { replacedBy: row.new_pass_id },
      });
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
