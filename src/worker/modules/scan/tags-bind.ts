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
import type { ServiceContext } from '../../platform/service-context.ts';
import { grantedAudit } from '../audit/repo-granted.ts';
import { assertTakesTag } from '../nfc/pass-state.ts';
import { assertSessionLevel, bindPolicy, tagsRefusal } from '../nfc/policy.ts';
import { activeBinding, type PassFacts } from '../nfc/repo-tag-bindings.ts';
import { orgTagCount, tagByRef } from '../nfc/repo-tags.ts';
import { addBind, type BindPlan, bindChecks, type TagActor } from '../nfc/repo-tags-write.ts';
import { assuranceOfSystem } from '../nfc/systems/registry.ts';
import { decideBind, TAGS_PER_ORG_MODE, triggerRefusal } from '../nfc/tags.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import type { ScanActor } from './guard.ts';
import { boundRow, bumpTagCap, cardFacts, ownerActiveCheck } from './repo-tags-bind.ts';
import { ROLE_RANK } from './rules.ts';
import { scanWriteGrant } from './scan-write-grant.ts';
import { scannerRefusal } from './scanner-credential-lost.ts';
import { skippedTitles } from './tag-assurance.ts';
import { approve, replay, requestHash, TAG_UNDO_MS } from './tags-bind-replay.ts';
import { opensDefault, tagCardPhoto } from './tags-card.ts';
import { cardPass, tagRights } from './tags-inspect.ts';
import { assertReadMatches, identifyRead, sunUsedMeanwhile } from './tags-sun.ts';

type BindRequest = z.infer<typeof ScanTagBindRequestSchema>;
type BindResult = z.infer<typeof ScanTagBindResultSchema>;
type Warning = z.infer<typeof ScanTagWarningSchema>;

const ATTEMPTS = 3;
export const TABLES = ['nfc_tags', 'tag_bindings', 'nfc_tag_sun'];
const CODES = { lineage: 'TAG_HOLDER_CHANGED', stale: 'TAG_HOLDER_CHANGED' } as const;

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
    throw new ValidationError(
      'A loaner is a visitor tag type. Pick that type instead.',
      [],
      'TAG_POOL_UNSUPPORTED',
    );
  const off = await tagsRefusal(ctx, orgId);
  if (off) throw off;
  await bumpTagCap(db, req.preview ? 'preview' : 'bind', scannerId, ctx.clock.now());
  await ensureCredentialRefKeyset(db, ctx.env);
  const identity = await identifyRead(ctx, actor, req.tag);
  const { ref, hint } = identity;
  const replayed = await replay(ctx, scannerId, req, ref);
  if (replayed) return replayed;
  assertSessionLevel(actor.settings.tags?.level, identity.system);

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
  assertTakesTag(ctx, candidate, assuranceOfSystem(identity.system));
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
    photoUrl: await tagCardPhoto(ctx, actor, candidate),
  };
  const skipped =
    req.binding === 'user' && pass.ownerUserId
      ? await skippedTitles(
          ctx,
          actor,
          orgId,
          mode,
          pass.ownerUserId,
          assuranceOfSystem(identity.system),
        )
      : [];
  const staff = actor.staff;
  const by: TagActor = staff ? { type: 'staff', id: staff.id } : { type: 'scanner', id: scannerId };

  for (let attempt = 1; ; attempt++) {
    const tag = await tagByRef(db, orgId, mode, ref);
    await assertReadMatches(ctx, actor, identity, tag);
    const active = tag ? await activeBinding(db, tag.id) : null;
    const warnings: Warning[] = [];
    let decision: ReturnType<typeof decideBind> | null = null;
    try {
      decision = decideBind(
        tag,
        active,
        facts,
        { scope: req.binding, move: req.move },
        ctx.clock.now(),
      );
    } catch (error) {
      if (!req.preview || !(error instanceof AppError)) throw error;
      if (error.code === 'TAG_LOST') warnings.push('lost');
      else if (error.code === 'TAG_HELD_BY_OTHER') warnings.push('held_by_other');
      else throw error;
    }
    const policy =
      decision?.status === 'already_bound'
        ? null
        : await bindPolicy(ctx, {
            orgId,
            passId: pass.id,
            candidate,
            scope: req.binding,
            system: identity.system,
            tag,
            typeId: req.typeId,
            ending: decision?.end?.id ?? null,
          });
    if (decision?.status === 'replaced')
      warnings.push(active?.scope === 'user' ? 'replaces_user_tag' : 'replaces_pass_tag');
    if (tag?.lostAt != null && !warnings.includes('lost')) warnings.push('lost');
    const userOk = (p: typeof policy) =>
      ownerAccount &&
      p?.type?.scopes !== 'pass' &&
      rights.assignAll !== 'never' &&
      (manager || ROLE_RANK[rights.role] >= ROLE_RANK[rights.assignAll]);
    const result = (
      status: BindResult['status'],
      bindingId: string | null,
      undoUntil: number | null,
    ) => ({
      status,
      hint: tag?.hint ?? hint,
      assurance: assuranceOfSystem(identity.system),
      scope: req.binding,
      ...(policy
        ? {
            type: policy.type && {
              id: policy.type.id,
              name: policy.type.name,
              use: policy.type.use,
            },
          }
        : {}),
      bindingId,
      card: status === 'already_bound' ? { ...summary, photoUrl: null } : summary,
      ownerAccount,
      opensDefault: opensDefault(candidate, userOk(policy)),
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
      newTag: tag
        ? null
        : {
            ref,
            hint,
            label: req.label ?? null,
            system: identity.system,
            typeId: policy?.type?.id ?? null,
          },
      expiryDays: policy?.expiryDays ?? null,
      endsAt: policy?.endsAt ?? null,
      endLapsed: policy?.lapsed ?? [],
      sun: identity.sun,
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
      await sunUsedMeanwhile(ctx, actor, identity, error);
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
