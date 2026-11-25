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
import { withIdempotency } from '../../platform/idempotency.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { tagByRef, tagView } from '../nfc/repo-tags.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { policyActor } from './dto.ts';
import type { ScanActor } from './guard.ts';
import { passInScope } from './history-scope.ts';
import { markOut } from './occupancy/mark-out.ts';
import { insidePlaces } from './repo-sign-out.ts';
import { collectTags, lentBindings } from './repo-sign-out-tags.ts';
import { scanPolicy } from './rules.ts';
import { notFound } from './tags-bind.ts';
import {
  assertReadMatches,
  identifyRead,
  type ReadIdentity,
  sunUsedMeanwhile,
} from './tags-sun.ts';

type SignOutRequest = z.infer<typeof SignOutRequestSchema>;
type SignOutResult = z.infer<typeof SignOutResultSchema>;

/** A place the person already left, or one this actor cannot reach, is skipped: the rest still go. */
const skippable = (error: unknown): error is ConflictError | ValidationError =>
  (error instanceof ConflictError && error.code === 'NOT_INSIDE') ||
  (error instanceof ValidationError && error.code === 'SCAN_MARK_OUT_INVALID');

/** The pass and binding a tapped tag is lent to. A tag that is not lent is 409; an unknown one is 404. */
async function lentBindingOf(
  ctx: ServiceContext,
  actor: ScanActor,
  read: NonNullable<SignOutRequest['read']>,
): Promise<{
  passId: string;
  binding: { id: string; tagId: string };
  sun: { tagId: string; seen: NonNullable<ReadIdentity['sun']> } | null;
  identity: ReadIdentity;
}> {
  const db = ctx.env.DB;
  await ensureCredentialRefKeyset(db, ctx.env);
  const identity = await identifyRead(ctx, actor, read);
  const tag = await tagByRef(db, actor.orgId, actor.mode, identity.ref);
  await assertReadMatches(ctx, actor, identity, tag);
  if (!tag) throw notFound();
  const binding = (await tagView(db, actor.orgId, actor.mode, tag.id))?.binding;
  if (!binding?.lent || binding.scope !== 'pass')
    throw new ConflictError("This tag isn't lent.", 'TAG_NOT_LENT');
  return {
    passId: binding.passId,
    binding: { id: binding.id, tagId: tag.id },
    sun: identity.sun ? { tagId: tag.id, seen: identity.sun } : null,
    identity,
  };
}

async function run(
  ctx: ServiceContext,
  actor: ScanActor,
  req: SignOutRequest,
): Promise<SignOutResult> {
  const db = ctx.env.DB;
  const tapped = req.read ? await lentBindingOf(ctx, actor, req.read) : null;
  const pass = await getPass(db, tapped?.passId ?? req.passId ?? '', actor.orgId);
  // A tapped tag whose pass this device cannot reach is as unknown as another org's tag.
  if (!pass || pass.mode !== actor.mode || !passInScope(actor, pass.templateId))
    throw tapped ? notFound() : new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  const want = req.tag ?? (req.read ? 'returned' : 'none');

  let stay: number | null = null;
  let marked = 0;
  let skipped = 0;
  for (const place of await insidePlaces(db, actor.orgId, pass.id)) {
    try {
      const outcome = await markOut(
        ctx,
        actor,
        { idempotencyKey: ctx.ids.ordered(ctx.clock.now()), passId: pass.id, place },
        undefined,
        { signOut: true },
      );
      marked += 1;
      stay ??= outcome.occupancy?.stayMs ?? null;
    } catch (error) {
      if (!skippable(error)) throw error;
      // Only a place this device cannot reach is still inside; one the person left (or timed out of) is out.
      if (error instanceof ValidationError) skipped += 1;
      ctx.log.warn('scan.sign_out_place_skipped', { orgId: actor.orgId, code: error.code });
    }
  }

  // A tap collects only the tapped tag; naming the pass collects every loaner it holds.
  const lent = tapped
    ? [tapped.binding]
    : want === 'none'
      ? []
      : await lentBindings(db, actor.orgId, actor.mode, pass.id);
  if (want !== 'none' && lent.length > 0) {
    try {
      await collectTags(ctx, actor, pass, lent, want, tapped?.sun ?? undefined);
    } catch (error) {
      // A Secure counter used since the read is a failed check, not a tag that is not lent.
      if (tapped) await sunUsedMeanwhile(ctx, actor, tapped.identity, error);
      throw error;
    }
  }
  if (marked === 0 && skipped === 0 && lent.length === 0)
    throw new ConflictError('They are already out.', 'NOT_INSIDE');
  return {
    passId: pass.id,
    stayMs: stay,
    stillInside: skipped,
    tag: want !== 'none' && lent.length > 0 ? want : 'none',
  };
}

/**
 * POST /scan/sign-out (Desk and above): marks the person out of every tracked place they are in and
 * collects a lent tag. No visit is recorded; a pass with nothing to mark out and no tag to collect is 409
 * NOT_INSIDE. The whole call runs under the request key (stored 24 h, per scanner), so a repeat answers as
 * the first did, and the same key with another body is 409 SCAN_KEY_REUSED. A failed call releases the key;
 * its retry marks out only the places still open.
 */
export async function signOut(
  ctx: ServiceContext,
  actor: ScanActor,
  req: SignOutRequest,
): Promise<SignOutResult> {
  if (!scanPolicy(policyActor(actor), { kind: 'sign_out' }).allow)
    throw new ForbiddenError('Only Desk and above can sign someone out.', 'FORBIDDEN');
  const { idempotencyKey, ...body } = req;
  try {
    const out = await withIdempotency(
      ctx,
      {
        orgId: actor.orgId,
        mode: actor.mode,
        principal: actor.scanner ? `scanner:${actor.scanner.id}` : `user:${actor.actor.id}`,
        operation: 'POST /scan/sign-out',
        key: idempotencyKey,
        request: { method: 'POST', path: '/scan/sign-out', body },
      },
      async () => ({ status: 200, body: await run(ctx, actor, req) }),
    );
    return out.body as SignOutResult;
  } catch (error) {
    if (error instanceof ValidationError && error.code === 'IDEMPOTENCY_KEY_REUSED')
      throw new ConflictError('That request key was used for something else.', 'SCAN_KEY_REUSED');
    // The scanner client retries this code with the same key.
    if (error instanceof ConflictError && error.code === 'IDEMPOTENCY_IN_PROGRESS')
      throw new ConflictError('The first request is still running.', 'SCAN_IN_PROGRESS');
    throw error;
  }
}
