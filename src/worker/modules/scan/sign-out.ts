import type { z } from 'zod';
import type {
  SignOutRequestSchema,
  SignOutResultSchema,
} from '../../../shared/contracts/access-business.ts';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { tagByRef, tagView } from '../nfc/repo-tags.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { policyActor } from './dto.ts';
import type { ScanActor } from './guard.ts';
import { passInScope } from './history-scope.ts';
import { markOut } from './occupancy/mark-out.ts';
import { scanByKey } from './repo-scans.ts';
import { enteredAt, insidePlaces } from './repo-sign-out.ts';
import { collectedSince, collectTags, lentBindings } from './repo-sign-out-tags.ts';
import { scanPolicy } from './rules.ts';
import { notFound } from './tags-bind.ts';
import { assertReadMatches, identifyRead } from './tags-sun.ts';

type SignOutRequest = z.infer<typeof SignOutRequestSchema>;
type SignOutResult = z.infer<typeof SignOutResultSchema>;

/** A place the person already left, or one this actor cannot reach, is skipped: the rest still go. */
const skippable = (error: unknown): error is ConflictError | ValidationError =>
  (error instanceof ConflictError && error.code === 'NOT_INSIDE') ||
  (error instanceof ValidationError && error.code === 'SCAN_MARK_OUT_INVALID');

/** The pass a tapped tag is lent to. A tag that is not lent, or whose pass this device cannot reach, is not lent here. */
async function passOfLentTag(
  ctx: ServiceContext,
  actor: ScanActor,
  read: NonNullable<SignOutRequest['read']>,
): Promise<string> {
  const notLent = () => new ConflictError("This tag isn't lent.", 'TAG_NOT_LENT');
  const db = ctx.env.DB;
  await ensureCredentialRefKeyset(db, ctx.env);
  const identity = await identifyRead(ctx, actor, read);
  const tag = await tagByRef(db, actor.orgId, actor.mode, identity.ref);
  await assertReadMatches(ctx, actor, identity, tag);
  if (!tag) throw notFound();
  const binding = (await tagView(db, actor.orgId, actor.mode, tag.id))?.binding;
  if (!binding?.lent || binding.scope !== 'pass') throw notLent();
  return binding.passId;
}

/**
 * POST /scan/sign-out (Desk and above): marks the person out of every tracked place they are in and
 * collects a lent tag. No visit is recorded; a pass with nothing to mark out and no tag to collect is 409
 * NOT_INSIDE. The request key is the first place's mark-out key, so a repeat answers as the first did.
 */
export async function signOut(
  ctx: ServiceContext,
  actor: ScanActor,
  req: SignOutRequest,
): Promise<SignOutResult> {
  if (!scanPolicy(policyActor(actor), { kind: 'mark_out' }).allow)
    throw new ForbiddenError('Only Desk and above can sign someone out.', 'FORBIDDEN');
  const db = ctx.env.DB;
  const passId = req.read ? await passOfLentTag(ctx, actor, req.read) : (req.passId ?? '');
  const pass = await getPass(db, passId, actor.orgId);
  if (!pass || pass.mode !== actor.mode || !passInScope(actor, pass.templateId))
    throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  const want = req.tag ?? (req.read ? 'returned' : 'none');

  const prior = await scanByKey(db, actor.actorKey, req.idempotencyKey);
  if (prior && (prior.state !== 'done' || prior.passId !== pass.id))
    throw new ConflictError('That request key was used for something else.', 'SCAN_KEY_REUSED');
  let stay: number | null = null;
  let marked = 0;
  if (prior) {
    const since = prior.presenceScope
      ? await enteredAt(db, actor.orgId, pass.id, prior.presenceScope)
      : null;
    stay = since === null ? null : Math.max(0, prior.at - since);
  } else {
    let key: string | null = req.idempotencyKey;
    for (const place of await insidePlaces(db, actor.orgId, pass.id)) {
      try {
        const outcome = await markOut(ctx, actor, {
          idempotencyKey: key ?? ctx.ids.ordered(ctx.clock.now()),
          passId: pass.id,
          place,
        });
        marked += 1;
        key = null;
        stay ??= outcome.occupancy?.stayMs ?? null;
      } catch (error) {
        if (!skippable(error)) throw error;
        ctx.log.warn('scan.sign_out_place_skipped', { orgId: actor.orgId, code: error.code });
      }
    }
  }

  const lent = want === 'none' ? [] : await lentBindings(db, actor.orgId, actor.mode, pass.id);
  if (want !== 'none' && lent.length > 0) await collectTags(ctx, actor, pass, lent, want);
  if (!prior && marked === 0 && lent.length === 0) {
    if (req.read) throw new ConflictError("This tag isn't lent.", 'TAG_NOT_LENT');
    throw new ConflictError('They are already out.', 'NOT_INSIDE');
  }
  const tag = lent.length > 0 ? want : prior ? await collectedSince(db, pass.id, prior.at) : 'none';
  return { passId: pass.id, stayMs: stay, tag };
}
