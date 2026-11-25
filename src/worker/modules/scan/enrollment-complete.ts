import type { z } from 'zod';
import type { ScanTagEnrollmentDoneSchema } from '../../../shared/contracts/nfc-tag-enrollments.ts';
import type { TagRead } from '../../../shared/contracts/nfc-tags.ts';
import { exactlyOne } from '../../platform/authority-checks.ts';
import { exists } from '../../platform/authority-cond.ts';
import { gt } from '../../platform/authority-expr.ts';
import { classifyD1Error } from '../../platform/db.ts';
import { ConflictError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { grantedAudit } from '../audit/repo-granted.ts';
import { assertBindable } from '../nfc/pass-state.ts';
import { assertSessionLevel, bindPolicy, tagsRefusal } from '../nfc/policy.ts';
import { requesterHolds } from '../nfc/repo-enrollments.ts';
import { activeBinding, type PassFacts, passFacts } from '../nfc/repo-tag-bindings.ts';
import { orgTagCount, tagByRef } from '../nfc/repo-tags.ts';
import { addBind, type BindPlan, bindChecks, ENROLL_TABLES } from '../nfc/repo-tags-write.ts';
import { assuranceOfSystem } from '../nfc/systems/registry.ts';
import { decideBind, TAGS_PER_ORG_MODE, triggerRefusal } from '../nfc/tags.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { CODES, guarded, notFound, openRequest, ownRequest } from './enrollment-device.ts';
import type { ScanActor } from './guard.ts';
import { bumpTagCap, ownerActiveCheck } from './repo-tags-bind.ts';
import { scanWriteGrant } from './scan-write-grant.ts';
import { tagRights } from './tags-inspect.ts';
import { assertReadMatches, identifyRead, sunUsedMeanwhile } from './tags-sun.ts';

type Done = z.infer<typeof ScanTagEnrollmentDoneSchema>;

const ATTEMPTS = 3;

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
  const off = await tagsRefusal(ctx, orgId);
  if (off) throw off;
  await bumpTagCap(db, 'bind', scannerId, ctx.clock.now());
  await ensureCredentialRefKeyset(db, ctx.env);
  const identity = await identifyRead(ctx, actor, read);
  assertSessionLevel(actor.settings.tags?.level, identity.system);
  const pass = await passFacts(db, row.passId);
  const holderChanged = () =>
    new ConflictError('The pass changed hands. Ask for a new request.', 'TAG_HOLDER_CHANGED');
  if (!pass || pass.orgId !== orgId || pass.mode !== mode || pass.deletedAt !== null)
    throw holderChanged();
  // The holder the admin saw: a transfer inside the window refuses, whatever the scope.
  if (pass.credentialGeneration !== row.holderGeneration || pass.ownerUserId !== row.holderOwner)
    throw holderChanged();
  if (row.scope === 'user' && (pass.ownerUserId === null || pass.ownerUserId !== row.userId))
    throw holderChanged();
  await assertBindable(ctx, orgId, pass.id, assuranceOfSystem(identity.system));
  const { ref, hint } = identity;
  const facts: PassFacts = pass;

  for (let attempt = 1; ; attempt++) {
    const tag = await tagByRef(db, orgId, mode, ref);
    await assertReadMatches(ctx, actor, identity, tag);
    const active = tag ? await activeBinding(db, tag.id) : null;
    const decision = decideBind(
      tag,
      active,
      facts,
      { scope: row.scope, move: false },
      ctx.clock.now(),
    );
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
    const policy = await bindPolicy(ctx, {
      orgId,
      passId: pass.id,
      scope: row.scope,
      system: identity.system,
      tag,
      ending: decision.end?.id ?? null,
    });
    const plan: BindPlan = {
      tagId: tag?.id ?? ctx.ids.id(),
      newTag: tag
        ? null
        : { ref, hint, label: null, system: identity.system, typeId: policy.type?.id ?? null },
      expiryDays: policy.expiryDays,
      endsAt: policy.endsAt,
      endLapsed: policy.lapsed,
      sun: identity.sun,
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
      await sunUsedMeanwhile(ctx, actor, identity, error);
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
