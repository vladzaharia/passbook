import type { z } from 'zod';
import type {
  ScanTagBindRequestSchema,
  ScanTagBindResultSchema,
  ScanTagWarningSchema,
} from '../../../shared/contracts/nfc-tags.ts';
import { exists } from '../../platform/authority-cond.ts';
import { classifyD1Error } from '../../platform/db.ts';
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../platform/errors.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { grantedAudit } from '../audit/repo-granted.ts';
import { assertTakesTag } from '../nfc/pass-state.ts';
import { tagsRefusal } from '../nfc/policy.ts';
import { activeBinding, type PassFacts } from '../nfc/repo-tag-bindings.ts';
import { orgTagCount, tagByRef } from '../nfc/repo-tags.ts';
import { addBind, type BindPlan, bindChecks, type TagActor } from '../nfc/repo-tags-write.ts';
import { UID_SYSTEM } from '../nfc/systems/uid.ts';
import { decideBind, TAGS_PER_ORG_MODE, triggerRefusal } from '../nfc/tags.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { verifyApproval } from './approval.ts';
import type { ScanActor } from './guard.ts';
import {
  boundRow,
  bumpTagCap,
  cardFacts,
  liveActorGuard,
  ownerActiveCheck,
  replayRow,
} from './repo-tags-bind.ts';
import { guardMiss } from './repo-undo-approval-guard.ts';
import { ROLE_RANK } from './rules.ts';
import { scanWriteGrant } from './scan-write-grant.ts';
import { scannerRefusal } from './scanner-credential-lost.ts';
import { skippedTitles } from './tag-assurance.ts';
import { cardPass, tagRights, tagUid } from './tags-inspect.ts';

type BindRequest = z.infer<typeof ScanTagBindRequestSchema>;
type BindResult = z.infer<typeof ScanTagBindResultSchema>;
type Warning = z.infer<typeof ScanTagWarningSchema>;

/** Undo is on the device that assigned the tag, for this long. */
export const TAG_UNDO_MS = 10 * 60_000;
const ATTEMPTS = 3;
export const TABLES = ['nfc_tags', 'tag_bindings'];
const CODES = { lineage: 'TAG_HOLDER_CHANGED', stale: 'TAG_HOLDER_CHANGED' } as const;

/** A Manager's PIN for this assign: verified here, pinned in the grant, stored nowhere. */
async function approve(
  ctx: ServiceContext,
  actor: ScanActor,
  approval: BindRequest['approval'],
): Promise<{ id: string; authEpoch: number }> {
  if (actor.terminal || actor.apiKeyId)
    throw new ForbiddenError('A till cannot approve.', 'API_KEY_NO_APPROVAL');
  if (!approval) throw new ForbiddenError('A manager must approve this.', 'TAG_APPROVAL_REQUIRED');
  if (!approval.staffId && actor.settings.staffSignIn)
    throw new ValidationError('Choose the manager.', [], 'PIN_MANAGER_REQUIRED');
  const now = ctx.clock.now();
  const verified = await verifyApproval(ctx, actor, approval, liveActorGuard(actor, now));
  if (!verified) throw (await guardMiss(ctx.env.DB, actor, now)) ?? new ForbiddenError();
  return { id: verified.id, authEpoch: verified.authEpoch };
}

export /** What a bind asked for, without the tag's UID or the card's code. */
const requestHash = (req: BindRequest, ref: string) =>
  sha256Hex(JSON.stringify([ref, req.card, req.binding, req.move ?? false, req.label ?? null]));

/** A retry of a bind this device already made: the stored answer, even after Undo. The same key for another request is refused. */
async function replay(
  ctx: ServiceContext,
  scannerId: string,
  req: BindRequest,
  ref: string,
): Promise<BindResult | null> {
  if (req.preview) return null;
  const row = await replayRow(ctx.env.DB, scannerId, req.idempotencyKey);
  if (!row) return null;
  if (row.requestHash !== (await requestHash(req, ref)))
    throw new ConflictError(
      'That request key was used for another assign.',
      'IDEMPOTENCY_KEY_REUSED',
    );
  const live = row.endedAt === null && ctx.clock.now() - row.boundAt <= TAG_UNDO_MS;
  return {
    status: 'bound',
    hint: row.hint,
    assurance: 'basic',
    scope: row.scope,
    bindingId: row.bindingId,
    card: {
      passId: row.passId,
      title: row.title ?? row.templateName,
      subtitle: row.subtitle,
      templateName: row.templateName,
      holderName: row.holderName,
      photoUrl: null,
    },
    ownerAccount: row.ownerActive,
    skipped: [],
    warnings: [],
    lostAt: row.lostAt,
    undoUntil: live ? row.boundAt + TAG_UNDO_MS : null,
  };
}

export const notFound = () => new NotFoundError('Tag not found.', 'TAG_NOT_FOUND');

/**
 * Binds a tag to the card's pass, or to its holder as a person, from a scanner. The card must be scanned
 * (possession); a lookup by id needs a Manager PIN, as does a role below the scanner's `tags` setting and a
 * move. With `preview` nothing is written. A retry of the same bind answers `already_bound`.
 */
export async function bindOnScanner(
  ctx: ServiceContext,
  actor: ScanActor,
  req: BindRequest,
): Promise<BindResult> {
  try {
    return await run(ctx, actor, req);
  } catch (error) {
    const refusal = await scannerRefusal(ctx, actor, error);
    if (refusal instanceof AppError)
      ctx.log.warn('scan.tag.refused', { orgId: actor.orgId, code: refusal.code });
    throw refusal;
  }
}

async function run(ctx: ServiceContext, actor: ScanActor, req: BindRequest): Promise<BindResult> {
  const rights = tagRights(actor);
  const { orgId, mode } = actor;
  const db = ctx.env.DB;
  const scannerId = rights.scannerId;
  if (req.pool)
    throw new ValidationError('Loaner tags are not available yet.', [], 'TAG_POOL_UNSUPPORTED');
  const off = await tagsRefusal(ctx, orgId);
  if (off) throw off;
  await bumpTagCap(db, req.preview ? 'preview' : 'bind', scannerId, ctx.clock.now());
  const uid = tagUid(req.tag);
  await ensureCredentialRefKeyset(db, ctx.env);
  const { ref, hint } = await UID_SYSTEM.identify(ctx.env, orgId, mode, uid);
  const replayed = await replay(ctx, scannerId, req, ref);
  if (replayed) return replayed;

  // A Manager PIN stands in for a role below the setting, and is the only way to look a card up by id.
  const manager = rights.role === 'manager';
  const needRole = req.binding === 'user' && !req.preview ? rights.assignAll : rights.assign;
  if (needRole === 'never')
    throw new ForbiddenError(
      'Assigning to a person is off on this scanner.',
      'TAG_ASSIGN_FORBIDDEN',
    );
  const lookup = 'passId' in req.card || req.card.method === 'manual';
  const short = ROLE_RANK[rights.role] < ROLE_RANK[needRole];
  let approver: { id: string; authEpoch: number } | null = null;
  if (!manager && (lookup || short)) approver = await approve(ctx, actor, req.approval);

  const input =
    'passId' in req.card
      ? { passId: req.card.passId, method: 'manual' as const }
      : { code: req.card.code, method: req.card.method };
  const { candidate, refs } = await cardPass(ctx, actor, input);
  const { pass } = candidate;
  assertTakesTag(ctx, candidate);
  const card = await cardFacts(db, pass.templateId, pass.ownerUserId);
  const ownerAccount = pass.ownerUserId !== null && card.ownerActive;
  if (req.binding === 'user' && !ownerAccount)
    throw new ValidationError(
      'This person has no account yet. Assign the tag to the pass instead.',
      [],
      'TAG_NO_ACCOUNT',
    );
  const facts: PassFacts = {
    id: pass.id,
    orgId: pass.orgId,
    mode: pass.mode,
    ownerUserId: pass.ownerUserId,
    credentialGeneration: pass.credentialGeneration,
    deletedAt: pass.deletedAt,
  };
  const summary = {
    passId: pass.id,
    title: pass.displayTitle ?? card.templateName,
    subtitle: pass.displaySubtitle,
    templateName: card.templateName,
    holderName: card.holderName,
    photoUrl: null,
  };
  const skipped =
    req.binding === 'user' && pass.ownerUserId
      ? await skippedTitles(ctx, actor, orgId, mode, pass.ownerUserId)
      : [];
  const staff = actor.staff;
  const by: TagActor = staff ? { type: 'staff', id: staff.id } : { type: 'scanner', id: scannerId };

  for (let attempt = 1; ; attempt++) {
    const tag = await tagByRef(db, orgId, mode, ref);
    const active = tag ? await activeBinding(db, tag.id) : null;
    const warnings: Warning[] = [];
    let decision: ReturnType<typeof decideBind> | null = null;
    try {
      decision = decideBind(tag, active, facts, { scope: req.binding, move: req.move });
    } catch (error) {
      if (!req.preview || !(error instanceof AppError)) throw error;
      if (error.code === 'TAG_LOST') warnings.push('lost');
      else if (error.code === 'TAG_HELD_BY_OTHER') warnings.push('held_by_other');
      else throw error;
    }
    if (decision?.status === 'replaced')
      warnings.push(active?.scope === 'user' ? 'replaces_user_tag' : 'replaces_pass_tag');
    if (tag?.lostAt != null && !warnings.includes('lost')) warnings.push('lost');
    const result = (
      status: BindResult['status'],
      bindingId: string | null,
      undoUntil: number | null,
    ) => ({
      status,
      hint: tag?.hint ?? hint,
      assurance: UID_SYSTEM.assurance,
      scope: req.binding,
      bindingId,
      card: summary,
      ownerAccount,
      skipped,
      warnings,
      lostAt: tag?.lostAt ?? null,
      undoUntil,
    });
    if (req.preview) return result('preview', null, null);
    if (!decision) throw notFound();
    if (decision.status === 'already_bound') {
      const bound = active ? await boundRow(db, active.id) : null;
      const mine = bound?.scannerId === scannerId && ctx.clock.now() - bound.boundAt <= TAG_UNDO_MS;
      return result(
        'already_bound',
        active?.id ?? null,
        mine && bound ? bound.boundAt + TAG_UNDO_MS : null,
      );
    }
    const takes = decision.status === 'moved' || tag?.lostAt != null;
    if (takes && !manager && !approver) approver = await approve(ctx, actor, req.approval);
    if (!tag && (await orgTagCount(db, orgId, mode)) >= TAGS_PER_ORG_MODE)
      throw new ConflictError('This organization has the most tags allowed.', 'TAG_LIMIT');

    const now = ctx.clock.now();
    const plan: BindPlan = {
      tagId: tag?.id ?? ctx.ids.id(),
      newTag: tag ? null : { ref, hint, label: req.label ?? null },
      bindingId: ctx.ids.id(),
      passId: pass.id,
      scope: req.binding,
      userId: req.binding === 'user' ? pass.ownerUserId : null,
      end: decision.end,
      holderGeneration: pass.credentialGeneration,
      holderOwner: pass.ownerUserId,
      clearsLost: tag?.lostAt != null,
      cleared: tag?.lostAt != null ? { at: tag.lostAt, by: tag.lostBy ?? 'unknown' } : null,
      idempotency: { key: req.idempotencyKey, hash: await requestHash(req, ref) },
      source: 'scanner',
      actor: by,
      scannerId,
      orgId,
      mode,
    };
    const g = scanWriteGrant(ctx, actor, {
      purpose: 'org_mode.scan.tag.bind',
      now,
      pass: { id: pass.id, facts: { pass, credential: {} } },
      credentialRefs: refs.credentialTombstoneRefs,
      approver,
      checks: [...bindChecks(plan), ...(plan.userId ? [ownerActiveCheck(plan.userId)] : [])],
      codes: CODES,
      tables: TABLES,
    });
    const insert = addBind(g, ctx, plan);
    if (approver)
      grantedAudit(
        g,
        ctx,
        {
          orgId,
          actorType: 'scanner',
          actorId: scannerId,
          action: 'tag.approve',
          targetType: 'tag',
          targetId: plan.tagId,
          detail: { approvedBy: approver.id, bindingId: plan.bindingId },
        },
        [exists('tag_bindings', { id: plan.bindingId })],
      );
    try {
      const results = await g.commit();
      if ((results[g.indexOf(insert)]?.results?.length ?? 0) === 1) {
        ctx.log.info('scan.tag.bound', { orgId, tagId: plan.tagId, scope: req.binding });
        return result(
          decision.status === 'moved' ? 'moved' : 'bound',
          plan.bindingId,
          now + TAG_UNDO_MS,
        );
      }
    } catch (error) {
      const refusal = triggerRefusal(error);
      if (refusal) throw refusal;
      if (classifyD1Error(error)?.kind !== 'unique' || attempt >= ATTEMPTS) throw error;
      const again = await replay(ctx, scannerId, req, ref);
      if (again) return again;
      continue;
    }
    // The tag row came from a concurrent bind under another id: read again.
    if (attempt >= ATTEMPTS)
      throw new ConflictError('The tag changed. Try again.', 'TAG_HOLDER_CHANGED');
  }
}
