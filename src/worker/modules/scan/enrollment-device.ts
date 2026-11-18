import type { z } from 'zod';
import type {
  ScanTagEnrollmentDoneSchema,
  ScanTagEnrollmentSchema,
  TagRead,
} from '../../../shared/contracts/nfc-tags.ts';
import { exactlyOne } from '../../platform/authority-checks.ts';
import { exists } from '../../platform/authority-cond.ts';
import { gt } from '../../platform/authority-expr.ts';
import { classifyD1Error } from '../../platform/db.ts';
import { AppError, ConflictError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { grantedAudit } from '../audit/repo-granted.ts';
import { tagsEnabled } from '../nfc/policy.ts';
import {
  deviceFacts,
  type EnrollmentRow,
  enrollmentRow,
  pendingForScanner,
  requesterHolds,
} from '../nfc/repo-enrollments.ts';
import { activeBinding, type PassFacts, passFacts } from '../nfc/repo-tag-bindings.ts';
import { orgTagCount, tagByRef } from '../nfc/repo-tags.ts';
import { addBind, type BindPlan, bindChecks, ENROLL_TABLES } from '../nfc/repo-tags-write.ts';
import { canonicalUid, tagRef } from '../nfc/tag-ref.ts';
import { decideBind, TAGS_PER_ORG_MODE, triggerRefusal } from '../nfc/tags.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import type { ScanActor } from './guard.ts';
import { bumpTagCap, ownerActiveCheck } from './repo-tags-bind.ts';
import { scanWriteGrant } from './scan-write-grant.ts';
import { scannerRefusal } from './scanner-credential-lost.ts';
import { tagRights, tagUid } from './tags-inspect.ts';

type Pending = z.infer<typeof ScanTagEnrollmentSchema>;
type Done = z.infer<typeof ScanTagEnrollmentDoneSchema>;

const ATTEMPTS = 3;
const CODES = {
  lineage: 'TAG_HOLDER_CHANGED',
  stale: 'ENROLLMENT_ENDED',
  retention: 'TAG_REQUEST_REVOKED',
} as const;

const notFound = () => new NotFoundError('Request not found.', 'ENROLLMENT_NOT_FOUND');

/** The request is this device's, in its org and mode. Any other id answers the same 404. */
async function ownRequest(ctx: ServiceContext, actor: ScanActor, id: string, scannerId: string) {
  const row = await enrollmentRow(ctx.env.DB, id);
  if (!row || row.orgId !== actor.orgId || row.mode !== actor.mode || row.scannerId !== scannerId)
    throw notFound();
  return row;
}

/** Still pending: ended and lapsed requests answer with their own codes. */
function openRequest(row: EnrollmentRow, now: number): void {
  if (row.state !== 'pending') throw new ConflictError('This request is over.', 'ENROLLMENT_ENDED');
  if (row.expiresAt <= now)
    throw new ConflictError('This request expired. Ask for a new one.', 'TAG_REQUEST_EXPIRED');
}

async function guarded<T>(
  ctx: ServiceContext,
  actor: ScanActor,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const refusal = await scannerRefusal(ctx, actor, error);
    if (refusal instanceof AppError)
      ctx.log.warn('scan.tag.enroll.refused', { orgId: actor.orgId, code: refusal.code });
    throw refusal;
  }
}

/**
 * The device's open request: only the holder's name, the pass title and the expiry. Fetching it marks the
 * request shown, which the admin page reads. A request whose pass changed hands answers none.
 */
export function pendingEnrollment(
  ctx: ServiceContext,
  actor: ScanActor,
): Promise<{ enrollment: Pending | null }> {
  return guarded(ctx, actor, async () => {
    const { scannerId } = tagRights(actor);
    const none = { enrollment: null };
    if (!(await tagsEnabled(ctx, actor.orgId))) return none;
    const row = await pendingForScanner(ctx.env.DB, actor.orgId, actor.mode, scannerId);
    const now = ctx.clock.now();
    if (!row || row.expiresAt <= now) return none;
    const facts = await deviceFacts(ctx.env.DB, row);
    if (facts.deleted || (row.scope === 'user' && facts.ownerId !== row.userId)) return none;
    if (row.shownAt === null) {
      const g = scanWriteGrant(ctx, actor, {
        purpose: 'org_mode.scan.tag.enroll',
        now,
        checks: [
          exactlyOne('tag_enrollments', { id: row.id, state: 'pending' }, undefined, 'stale'),
        ],
        codes: CODES,
        tables: [...ENROLL_TABLES],
      });
      g.update('tag_enrollments', {
        set: { shown_at: now },
        where: { id: row.id, state: 'pending', scanner_id: scannerId },
      });
      await g.commit();
    }
    return {
      enrollment: {
        id: row.id,
        holderName: facts.holderName ?? facts.passTitle ?? facts.templateName,
        passTitle: facts.passTitle ?? facts.templateName,
        scope: row.scope,
        requestedByName: facts.requestedByName,
        expiresAt: row.expiresAt,
      },
    };
  });
}

/** The device turns the request down. */
export function declineEnrollment(
  ctx: ServiceContext,
  actor: ScanActor,
  id: string,
): Promise<{ status: 'declined' }> {
  return guarded(ctx, actor, async () => {
    const { scannerId } = tagRights(actor);
    const row = await ownRequest(ctx, actor, id, scannerId);
    const now = ctx.clock.now();
    openRequest(row, now);
    const g = scanWriteGrant(ctx, actor, {
      purpose: 'org_mode.scan.tag.enroll',
      now,
      checks: [
        exactlyOne(
          'tag_enrollments',
          { id, scanner_id: scannerId, state: 'pending' },
          undefined,
          'stale',
        ),
      ],
      codes: CODES,
      tables: [...ENROLL_TABLES],
    });
    g.update('tag_enrollments', {
      set: { state: 'declined', ended_at: now },
      where: { id, state: 'pending' },
    });
    grantedAudit(
      g,
      ctx,
      {
        orgId: actor.orgId,
        actorType: 'device',
        actorId: scannerId,
        action: 'tag.enroll.decline',
        targetType: 'enrollment',
        targetId: id,
        detail: { passId: row.passId, scannerId },
      },
      [exists('tag_enrollments', { id, state: 'declined' })],
    );
    await g.commit();
    return { status: 'declined' };
  });
}

/**
 * The device read a tag for an open request: binds it to the request's pass, or to the pass's owner as a
 * person, under the device's grant. No card is scanned: the requesting admin is the authority, and their
 * membership must still grant passes:operate at commit. The request is single use.
 */
export function completeEnrollment(
  ctx: ServiceContext,
  actor: ScanActor,
  id: string,
  read: TagRead,
): Promise<Done> {
  return guarded(ctx, actor, () => complete(ctx, actor, id, read));
}

async function complete(
  ctx: ServiceContext,
  actor: ScanActor,
  id: string,
  read: TagRead,
): Promise<Done> {
  const { scannerId } = tagRights(actor);
  const { orgId, mode } = actor;
  const db = ctx.env.DB;
  const row = await ownRequest(ctx, actor, id, scannerId);
  openRequest(row, ctx.clock.now());
  if (!(await tagsEnabled(ctx, orgId)))
    throw new ConflictError('Turn on tags in settings first.', 'TAGS_OFF');
  await bumpTagCap(db, 'bind', scannerId, ctx.clock.now());
  const uid = tagUid(read);
  const pass = await passFacts(db, row.passId);
  const holderChanged = () =>
    new ConflictError('The pass changed hands. Ask for a new request.', 'TAG_HOLDER_CHANGED');
  if (!pass || pass.orgId !== orgId || pass.mode !== mode || pass.deletedAt !== null)
    throw holderChanged();
  if (row.scope === 'user' && (pass.ownerUserId === null || pass.ownerUserId !== row.userId))
    throw holderChanged();
  await ensureCredentialRefKeyset(db, ctx.env);
  const { ref, hint } = await tagRef(ctx.env, orgId, mode, canonicalUid(uid));
  const facts: PassFacts = pass;

  for (let attempt = 1; ; attempt++) {
    const tag = await tagByRef(db, orgId, mode, ref);
    const active = tag ? await activeBinding(db, tag.id) : null;
    const decision = decideBind(tag, active, facts, { scope: row.scope, move: false });
    const now = ctx.clock.now();
    const checks = [
      exactlyOne(
        'tag_enrollments',
        { id, scanner_id: scannerId, state: 'pending', expires_at: gt(now) },
        undefined,
        'stale',
      ),
      requesterHolds(row.requestedBy, row.createdAt),
    ];
    const finish = (g: ReturnType<typeof scanWriteGrant>, bindingId: string, tagId: string) => {
      g.update('tag_enrollments', {
        set: { state: 'done', ended_at: now, binding_id: bindingId },
        where: { id, state: 'pending' },
        when: [exists('tag_bindings', { id: bindingId })],
      });
      grantedAudit(
        g,
        ctx,
        {
          orgId,
          actorType: 'device',
          actorId: scannerId,
          action: 'tag.enroll.complete',
          targetType: 'enrollment',
          targetId: id,
          detail: { tagId, bindingId, scope: row.scope, passId: row.passId },
        },
        [exists('tag_enrollments', { id, state: 'done' })],
      );
    };
    const done = (bindingId: string, tagHint: string): Done => ({
      status: 'done',
      hint: tagHint,
      scope: row.scope,
      bindingId,
    });

    if (decision.status === 'already_bound' && active) {
      const g = scanWriteGrant(ctx, actor, {
        purpose: 'org_mode.scan.tag.enroll',
        now,
        checks,
        codes: CODES,
        tables: [...ENROLL_TABLES],
      });
      finish(g, active.id, active.tagId);
      await g.commit();
      return done(active.id, tag?.hint ?? hint);
    }
    if (decision.status === 'already_bound') throw notFound();
    if (!tag && (await orgTagCount(db, orgId, mode)) >= TAGS_PER_ORG_MODE)
      throw new ConflictError('This organization has the most tags allowed.', 'TAG_LIMIT');
    const plan: BindPlan = {
      tagId: tag?.id ?? ctx.ids.id(),
      newTag: tag ? null : { ref, hint, label: null },
      bindingId: ctx.ids.id(),
      passId: pass.id,
      scope: row.scope,
      userId: row.scope === 'user' ? pass.ownerUserId : null,
      end: decision.end,
      holderGeneration: pass.credentialGeneration,
      holderOwner: pass.ownerUserId,
      clearsLost: false,
      source: 'remote',
      actor: { type: 'user', id: row.requestedBy },
      scannerId,
      orgId,
      mode,
    };
    const g = scanWriteGrant(ctx, actor, {
      purpose: 'org_mode.scan.tag.enroll',
      now,
      checks: [
        ...checks,
        ...bindChecks(plan),
        ...(plan.userId ? [ownerActiveCheck(plan.userId)] : []),
      ],
      codes: CODES,
      tables: [...ENROLL_TABLES],
    });
    const insert = addBind(g, ctx, plan);
    finish(g, plan.bindingId, plan.tagId);
    try {
      const results = await g.commit();
      if ((results[g.indexOf(insert)]?.results?.length ?? 0) === 1) {
        ctx.log.info('scan.tag.enrolled', { orgId, tagId: plan.tagId, scope: row.scope });
        return done(plan.bindingId, tag?.hint ?? hint);
      }
    } catch (error) {
      const refusal = triggerRefusal(error);
      if (refusal) throw refusal;
      if (classifyD1Error(error)?.kind !== 'unique' || attempt >= ATTEMPTS) throw error;
      continue;
    }
    // The tag row came from a concurrent bind under another id: read again.
    if (attempt >= ATTEMPTS)
      throw new ConflictError('The tag changed. Try again.', 'TAG_HOLDER_CHANGED');
  }
}
