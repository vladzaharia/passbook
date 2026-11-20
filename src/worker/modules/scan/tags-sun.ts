import type { Mode } from '../../../shared/contracts/common.ts';
import type { TagRead } from '../../../shared/contracts/nfc-tags.ts';
import { AppError, ConflictError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { sunStoredByRef } from '../nfc/repo-sun.ts';
import { recogniseTag } from '../nfc/systems/registry.ts';
import { type SunProof, sunStale, sunStaleNow, verifySunTap } from '../nfc/systems/sun.ts';
import type { TagSystemId } from '../nfc/systems/types.ts';
import { UID_SYSTEM } from '../nfc/systems/uid.ts';
import { readableUid } from '../nfc/tag-ref.ts';

/** The tag a read names, proved by its system, in the actor's org and mode. */
export interface ReadIdentity {
  system: TagSystemId;
  ref: string;
  hint: string;
  /** A SUN read: the keyset, key version and counter that proved it. */
  sun: SunProof | null;
}

/** A read the tag systems refuse (not an operational fault): unreadable, random, or failed its check. */
export const refusedRead = (error: unknown): boolean =>
  error instanceof ValidationError || error instanceof ConflictError;

export const checkFailed = () =>
  new ConflictError('The tag failed its check. Use another tag.', 'TAG_CHECK_FAILED');

/**
 * Proves a read for a bind or an enrolment: a UID names a Basic tag; a SUN read is verified and names a Secure
 * one by its decrypted UID. Anything else cannot be assigned. A SUN refusal says only that the check failed.
 */
export async function identifyRead(
  ctx: ServiceContext,
  scope: { orgId: string; mode: Mode },
  read: TagRead,
): Promise<ReadIdentity> {
  const found = recogniseTag(read, ctx.env);
  if (found?.system === 'uid') {
    const { ref, hint } = await UID_SYSTEM.identify(ctx.env, scope.orgId, scope.mode, found.uid);
    return { system: 'uid', ref, hint, sun: null };
  }
  if (found?.system === 'sun') {
    const verified = await verifySunTap(ctx, scope.orgId, scope.mode, read);
    if (!verified.ok) {
      ctx.log.info('scan.tag_refused', { orgId: scope.orgId, code: verified.code });
      throw checkFailed();
    }
    const { ref, hint } = verified.proof;
    return { system: 'sun', ref, hint, sun: verified.proof };
  }
  if (read.uidRandom || (read.uid && readableUid({ uid: read.uid }) === null))
    throw new ValidationError('This tag changes its ID. Try another tag.', [], 'TAG_UID_RANDOM');
  throw new ValidationError("Can't read this tag. Try another tag.", [], 'TAG_UNREADABLE');
}

/**
 * The tag row a read found is of the read's system (a UID read never opens a Secure tag, and a SUN read
 * never a Basic one), and a SUN read is newer than the tag's counter. Reads only: the counter is used by the
 * write that follows. Throws `TAG_CHECK_FAILED`.
 */
export async function assertReadMatches(
  ctx: ServiceContext,
  scope: { orgId: string; mode: Mode },
  identity: ReadIdentity,
  tag: { system: TagSystemId } | null,
): Promise<void> {
  if (!tag) return;
  if (tag.system !== identity.system) {
    ctx.log.info('scan.tag_refused', { orgId: scope.orgId, code: 'TAG_SYSTEM_MISMATCH' });
    throw checkFailed();
  }
  if (!identity.sun) return;
  const stored = await sunStoredByRef(ctx.env.DB, scope.orgId, scope.mode, identity.ref);
  const refusal = stored ? sunStale(ctx, scope.orgId, identity.sun, stored) : 'TAG_SUN_ROW';
  if (refusal) {
    ctx.log.info('scan.tag_refused', { orgId: scope.orgId, code: refusal });
    throw checkFailed();
  }
}

/** A write that failed: if a SUN read was used in between, that is why. Otherwise the error stands. */
export async function sunUsedMeanwhile(
  ctx: ServiceContext,
  scope: { orgId: string; mode: Mode },
  identity: ReadIdentity,
  error: unknown,
): Promise<void> {
  if (!identity.sun || !(error instanceof AppError)) return;
  const refusal = await sunStaleNow(ctx, scope.orgId, scope.mode, identity.sun);
  if (!refusal) return;
  ctx.log.info('scan.tag_refused', { orgId: scope.orgId, code: refusal });
  throw checkFailed();
}
