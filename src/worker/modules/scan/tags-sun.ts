import type { Mode } from '../../../shared/contracts/common.ts';
import type { TagRead } from '../../../shared/contracts/nfc-tags.ts';
import type { ScanReason } from '../../../shared/contracts/scan.ts';
import { writeEvent } from '../../platform/analytics.ts';
import { bump } from '../../platform/counters.ts';
import { AppError, ConflictError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import {
  FOLLOW_UP_MS,
  sunFollowupStmt as followupStmt,
  type SunSeen,
  type SunStored,
  sunStoredByRef,
} from '../nfc/repo-sun.ts';
import { recogniseTag } from '../nfc/systems/registry.ts';
import {
  type SunProof,
  type SunRefusalCode,
  sunStale,
  sunStaleNow,
  verifySunTap,
} from '../nfc/systems/sun.ts';
import type { TagSystemId } from '../nfc/systems/types.ts';
import { UID_SYSTEM } from '../nfc/systems/uid.ts';
import { readableUid } from '../nfc/tag-ref.ts';
import type { ScanActor } from './guard.ts';

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

/** The device a tag call came from, for its failure count. */
export interface SunWho {
  orgId: string;
  mode: Mode;
  actorKey: string;
  scanner?: { id: string } | null;
}

const FAILED_WINDOW_MS = 600_000;

/**
 * A SUN read that did not verify (unknown keyset or bad MAC): counted per device in 10-minute windows, logged as
 * `TAG_SUN_FAILED` with the count and written as an analytics event, so an alert can fire before a limiter exists.
 * A refused read that merely was not fresh, or came from the other mode, is not counted.
 */
export async function noteSunFailure(
  ctx: ServiceContext,
  who: SunWho,
  reason: SunRefusalCode,
): Promise<void> {
  if (reason !== 'TAG_SUN_KEYSET' && reason !== 'TAG_SUN_VERIFY') return;
  const now = ctx.clock.now();
  const device = who.scanner?.id ?? who.actorKey;
  const count = await bump(
    ctx.env.DB,
    `scan:tag:sunfail:${device}`,
    now - (now % FAILED_WINDOW_MS),
  );
  ctx.log.warn('scan.tag_sun_failed', {
    orgId: who.orgId,
    code: 'TAG_SUN_FAILED',
    reason,
    device,
    count,
    windowMs: FAILED_WINDOW_MS,
  });
  writeEvent(
    ctx.env,
    { event: 'tag.sun_failed', orgId: who.orgId, mode: who.mode, outcome: reason, value: count },
    ctx.log,
  );
}

/**
 * What a verified read may do to the tag it names: use up a newer counter, or (a follow-up) present the read
 * its own device's heads-up already used, once. Refused with the log code otherwise.
 */
export function sunUse(
  ctx: ServiceContext,
  orgId: string,
  sun: SunProof,
  stored: SunStored | null,
  follow: { scanId: string | null; overrideOf?: string | undefined },
): { seen: SunSeen } | { refused: SunRefusalCode } {
  const seen: SunSeen = {
    keysetId: sun.keysetId,
    slug: sun.slug,
    keyVersion: sun.keyVersion,
    ctr: sun.ctr,
  };
  const refusal = stored ? sunStale(ctx, orgId, sun, stored) : 'TAG_SUN_ROW';
  if (!refusal) return { seen };
  const same = stored && stored.ctr === sun.ctr && stored.keyVersion === sun.keyVersion;
  if (
    refusal === 'TAG_SUN_REPLAY' &&
    same &&
    follow.scanId &&
    (!follow.overrideOf || follow.overrideOf === follow.scanId)
  )
    return { seen: { ...seen, followUp: follow.scanId } };
  return { refused: refusal };
}

/** The tag a read names: a UID, or a SUN read the plugin verified. */
export type TagId = { uid: string } | { sun: SunProof };

/** Step 1b: a SUN read is verified before anything else reads it; a refusal is what the door answers. */
export async function verifiedSunId(
  ctx: ServiceContext,
  actor: ScanActor,
  read: TagRead,
): Promise<{ id: TagId } | { refused: ScanReason }> {
  const verified = await verifySunTap(ctx, actor.orgId, actor.mode, read);
  if (verified.ok) return { id: { sun: verified.proof } };
  ctx.log.info('scan.tag_refused', { orgId: actor.orgId, code: verified.code });
  await noteSunFailure(ctx, actor, verified.code);
  return { refused: verified.reason };
}

/** For a batch: the follow-up scan, if any, a device's heads-up on this tag left for this read. */
export const sunFollowupStmt = (
  ctx: ServiceContext,
  actor: ScanActor,
  ref: string,
  sun: SunProof,
) =>
  followupStmt(ctx.env.DB, {
    orgId: actor.orgId,
    mode: actor.mode,
    ref,
    actorKey: actor.actorKey,
    ctr: sun.ctr,
    since: ctx.clock.now() - FOLLOW_UP_MS,
  });

export const checkFailed = () =>
  new ConflictError('The tag failed its check. Use another tag.', 'TAG_CHECK_FAILED');

/**
 * Proves a read for a bind or an enrolment: a UID names a Basic tag; a SUN read is verified and names a Secure
 * one by its decrypted UID. Anything else cannot be assigned. A SUN refusal says only that the check failed.
 */
export async function identifyRead(
  ctx: ServiceContext,
  scope: SunWho,
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
      await noteSunFailure(ctx, scope, verified.code);
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
