import type { z } from 'zod';
import type {
  TagProgramStartedSchema,
  TagProgramStartSchema,
} from '../../../shared/contracts/nfc-tag-programs.ts';
import { featureNotIncluded } from '../../../shared/copy/entitlements.ts';
import { exists } from '../../platform/authority-cond.ts';
import { type KekRing, loadKekRing } from '../../platform/crypto.ts';
import { classifyD1Error } from '../../platform/db.ts';
import { entitlementsOf, isEntitled } from '../../platform/entitlements.ts';
import { FeatureNotIncludedError } from '../../platform/errors.ts';
import { randomBytes } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { grantedAudit } from '../audit/repo-granted.ts';
import { isNtag424, parseVersion } from './ntag424/apdu.ts';
import { ZERO16 } from './ntag424/bytes.ts';
import { authPart2 } from './ntag424/ev2.ts';
import { verifyOriginality } from './ntag424/originality.ts';
import { tagsRefusal } from './policy.ts';
import { actorKeyOf, endHold, nfcChecks, programAudit, scopeOf } from './program-hold.ts';
import { activeVersion } from './program-keys.ts';
import { ATTEMPT_CAP, HOLD_TTL_MS, mapNtag, programError } from './program-recover.ts';
import { hex, openSession, type SessionState, sealSession, unhex } from './program-seal.ts';
import {
  onlyProgrammableKeyset,
  type ProgramAuthority,
  type ProgramRow,
  programByIdem,
  programGrant,
  programKeyset,
  unresolvedByRef,
} from './repo-programs.ts';
import { changed, insertProgram, moveProgram } from './repo-programs-write.ts';
import { tagByRef } from './repo-tags.ts';
import { tagRef } from './tag-ref.ts';

type StartRequest = z.infer<typeof TagProgramStartSchema>;
type Started = z.infer<typeof TagProgramStartedSchema>;

const ROUNDS = 3;

/**
 * The UID in GetVersion part 3, proved genuine by NXP's signature over it, on an NTAG 424 DNA. The request's own
 * `uid` is a claim that must agree; nothing else names the tag.
 */
export function genuineUid(req: Pick<StartRequest, 'uid' | 'version' | 'sig'>): string {
  const v = unhex(req.version);
  let version: ReturnType<typeof parseVersion>;
  try {
    version = parseVersion(v.slice(0, 7), v.slice(7, 14), v.slice(14));
  } catch (error) {
    throw mapNtag(error);
  }
  if (!isNtag424(version)) throw programError('TAG_NOT_424');
  const uid = hex(version.uid);
  if (uid !== req.uid.toLowerCase() || !verifyOriginality(version.uid, unhex(req.sig)))
    throw programError('TAG_NOT_GENUINE');
  return uid;
}

/** Auth part 2 under the factory key: the intended K0 is only tried after the tag refuses this one. */
async function newHold(by: string, req: StartRequest): Promise<SessionState> {
  const rndA = randomBytes(16);
  let part2: Awaited<ReturnType<typeof authPart2>>;
  try {
    part2 = await authPart2(ZERO16, unhex(req.auth1), rndA);
  } catch (error) {
    throw mapNtag(error);
  }
  return {
    by,
    idem: req.idem,
    candidate: 0,
    auth1: req.auth1.toLowerCase(),
    rndA: hex(rndA),
    rndB: hex(part2.rndB),
    part2: hex(part2.apdu),
  };
}

const answer = (
  row: Pick<ProgramRow, 'id' | 'expiresAt'>,
  s: SessionState,
  resume: boolean,
): Started => ({ id: row.id, resume, apdus: [s.part2], expiresAt: row.expiresAt });

/** The same start again, before anything moved: the same answer, and no attempt spent. */
async function replayOf(
  ring: KekRing,
  row: ProgramRow | null,
  by: string,
  req: StartRequest,
): Promise<Started | null> {
  if (!row?.session || row.state !== 'started' || row.step !== 'auth') return null;
  const held = await openSession(ring, scopeOf(row), row.id, row.session);
  const same = held.by === by && held.idem === req.idem && held.auth1 === req.auth1.toLowerCase();
  return same ? answer(row, held, row.intended !== null) : null;
}

/**
 * Step 1 of a hold: the tag's own answers (version, originality signature, auth part 1) before any key is used.
 * A tag the org has is refused. A tag with an unresolved row resumes that row, so keys already released are
 * never replaced (and a tag at its attempt cap is refused without another try). Returns auth part 2 under the
 * factory key.
 */
export async function startProgram(
  ctx: ServiceContext,
  a: ProgramAuthority,
  req: StartRequest,
): Promise<Started> {
  const off = await tagsRefusal(ctx, a.orgId);
  if (off) throw off;
  // Programming makes Secure tags: the plan must include them, not just Basic ones.
  if (!isEntitled(await entitlementsOf(ctx, a.orgId), 'nfc', 'secure'))
    throw new FeatureNotIncludedError('nfc', featureNotIncluded('nfc'));
  if (req.purpose !== 'blank') throw programError('TAG_PROGRAM_FAILED');
  const uid = genuineUid(req);
  const db = ctx.env.DB;
  const { ref, hint } = await tagRef(ctx.env, a.orgId, a.mode, uid);
  if (await tagByRef(db, a.orgId, a.mode, ref)) throw programError('TAG_KNOWN');
  const by = actorKeyOf(a);
  const ring = await loadKekRing(ctx.env);

  for (let round = 1; round <= ROUNDS; round++) {
    const open = await unresolvedByRef(db, a.orgId, a.mode, ref);
    const used = open ? null : await programByIdem(db, a.orgId, a.mode, by, req.idem);
    const replayed = await replayOf(ring, open ?? used, by, req);
    if (replayed) return replayed;
    if (used) throw programError('TAG_PROGRAM_FAILED');
    const keysetId =
      open?.keysetId ?? req.keysetId ?? (await onlyProgrammableKeyset(db, a.orgId, a.mode));
    const keyset = keysetId ? await programKeyset(db, a.orgId, a.mode, keysetId) : null;
    if (!keyset?.perTag || !keyset.programmable || keyset.disabled)
      throw programError('KEYSET_NOT_PROGRAMMABLE');
    if (open && req.keysetId && req.keysetId !== open.keysetId)
      throw programError('TAG_PROGRAM_FAILED');
    const started = open
      ? await resume(ctx, a, ring, open, req)
      : await begin(ctx, a, ring, { keysetId: keyset.id, ref, hint }, req);
    if (started) return started;
  }
  throw programError('TAG_PROGRAM_FAILED');
}

async function begin(
  ctx: ServiceContext,
  a: ProgramAuthority,
  ring: KekRing,
  tag: { keysetId: string; ref: string; hint: string },
  req: StartRequest,
): Promise<Started | null> {
  const version = await activeVersion(ctx.env.DB, tag.keysetId);
  if (version === null) throw programError('KEYSET_NOT_PROGRAMMABLE');
  const id = ctx.ids.id();
  const now = ctx.clock.now();
  const hold = await newHold(actorKeyOf(a), req);
  const g = programGrant(ctx, a, nfcChecks());
  const row = {
    id,
    keysetId: tag.keysetId,
    keyVersion: version,
    tagRef: tag.ref,
    hint: tag.hint,
    actor: a.actor,
    idem: req.idem,
    session: await sealSession(
      ring,
      { orgId: a.orgId, mode: a.mode, keysetId: tag.keysetId },
      id,
      hold,
    ),
    now,
    expiresAt: now + HOLD_TTL_MS,
  };
  insertProgram(g, row);
  grantedAudit(g, ctx, programAudit(a, row, 'nfc_tag.program_started'), [
    exists('nfc_tag_programs', { id }),
  ]);
  try {
    await g.commit();
  } catch (error) {
    // Another start made the row first: read again and resume it.
    if (classifyD1Error(error)?.kind === 'unique') return null;
    throw error;
  }
  ctx.log.info('nfc.program.started', { orgId: a.orgId, programId: id, hint: tag.hint });
  return answer({ id, expiresAt: row.expiresAt }, hold, false);
}

async function resume(
  ctx: ServiceContext,
  a: ProgramAuthority,
  ring: KekRing,
  open: ProgramRow,
  req: StartRequest,
): Promise<Started | null> {
  if (open.state === 'failed') throw programError('TAG_PROGRAM_FAILED');
  const now = ctx.clock.now();
  const by = actorKeyOf(a);
  // Another device's live hold is not ours to take: its session is the fence of its next call.
  if (
    open.session &&
    (open.state === 'started' || open.state === 'scripted') &&
    now <= open.expiresAt
  ) {
    const held = await openSession(ring, scopeOf(open), open.id, open.session);
    if (held.by !== by) throw programError('TAG_PROGRAM_BUSY');
  }
  if (open.attempts >= ATTEMPT_CAP) {
    if (open.state === 'abandoned') throw programError('TAG_PROGRAM_FAILED');
    return endHold(ctx, a, open, 'TAG_PROGRAM_FAILED', { to: 'failed' });
  }
  // The keys go back to the device that first released them, or to a Manager.
  const original = open.releasedBy === null || open.releasedBy === by;
  if (!original && !a.manager) throw programError('TAG_PROGRAM_FAILED');
  const hold = await newHold(by, req);
  const g = programGrant(ctx, a, nfcChecks());
  const expiresAt = now + HOLD_TTL_MS;
  const move = moveProgram(g, open.id, {
    from: [open.state],
    to: 'started',
    toStep: 'auth',
    now,
    expiresAt,
    errorCode: null,
    session: await sealSession(ring, scopeOf(open), open.id, hold),
    attempt: { cap: ATTEMPT_CAP },
    fence: open.session,
  });
  grantedAudit(
    g,
    ctx,
    programAudit(a, open, 'nfc_tag.program_started', {
      resume: true,
      keysTo: original ? 'releaser' : 'manager',
    }),
    [exists('nfc_tag_programs', { id: open.id, state: 'started' })],
  );
  const results = await g.commit();
  if (!changed(results, g, move)) return null;
  ctx.log.info('nfc.program.resumed', { orgId: a.orgId, programId: open.id, hint: open.hint });
  return answer({ id: open.id, expiresAt }, hold, true);
}
