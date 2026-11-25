import type { z } from 'zod';
import type {
  TagProgramAbortSchema,
  TagProgramAuthSchema,
  TagProgramProbeSchema,
  TagProgramReauthedSchema,
  TagProgramReauthSchema,
  TagProgramStepSchema,
} from '../../../shared/contracts/nfc-tag-programs.ts';
import { exists } from '../../platform/authority-cond.ts';
import { type KekRing, loadKekRing } from '../../platform/crypto.ts';
import { randomBytes } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { grantedAudit } from '../audit/repo-granted.ts';
import { SW, splitResponse } from './ntag424/apdu.ts';
import { authFinish, authFirstApdu, authPart2 } from './ntag424/ev2.ts';
import {
  actorKeyOf,
  endHold,
  type Hold,
  loadHold,
  nfcChecks,
  programAudit,
  scopeOf,
} from './program-hold.ts';
import { metaKeyOf, newKeys } from './program-keys.ts';
import { ATTEMPT_CAP, mapNtag, oldKeysFromProbe, programError } from './program-recover.ts';
import { checkBatch, probeBatch, scriptBatch, sesOf, sessionOf } from './program-script.ts';
import {
  hex,
  type Next,
  openIntended,
  type SessionState,
  sealIntended,
  sealSession,
  unhex,
} from './program-seal.ts';
import {
  changed,
  moveProgram,
  type ProgramAuthority,
  programById,
  programGrant,
  programKeyset,
} from './repo-programs.ts';

type Step = z.infer<typeof TagProgramStepSchema>;

const lower = (list: string[]) => list.map((x) => x.toLowerCase());
const sameList = (a: string[] | undefined, b: string[]) =>
  a !== undefined && a.length === b.length && a.every((x, i) => x === b[i]);

/** What `/auth` and `/probe` answer: the batch and what comes after it. */
const asStep = (n: Next): Step => n as Step;

/**
 * The answer to auth part 2. A refused factory key is the intended K0's turn, but only for a row that has
 * released keys (an open scripted row): a tag that is not blank and not ours is refused here, with no second
 * try. A verified key opens the session; then a fresh tag gets its keys (sealed and committed before the script
 * leaves), a resumed one its probe, and a tag that proved the intended K0 only its NDEF and settings again.
 */
export async function authProgram(
  ctx: ServiceContext,
  a: ProgramAuthority,
  id: string,
  req: z.infer<typeof TagProgramAuthSchema>,
): Promise<Step> {
  const hold = await loadHold(ctx, a, id);
  const { row, session } = hold;
  const answer = (req.responses[0] as string).toLowerCase();
  // A repeated answer gets the answer it got, however far the hold went: the tag's own session is gone, so a
  // replayed script fails there, harmlessly.
  if (
    session.authStep &&
    session.authAnswer === answer &&
    (row.state !== 'started' || row.step !== 'auth')
  )
    return asStep(session.authStep);
  if (row.state !== 'started' || row.step !== 'auth') throw programError('TAG_PROGRAM_FAILED');
  let response: ReturnType<typeof splitResponse>;
  try {
    response = splitResponse(unhex(answer));
  } catch (error) {
    return endHold(ctx, a, row, mapNtag(error).code as 'TAG_PROGRAM_FAILED');
  }
  if (response.sw === SW.authError) return refused(ctx, a, hold, answer);
  if (response.sw !== SW.ok) return endHold(ctx, a, row, 'TAG_MOVED');
  const ring = await loadKekRing(ctx.env);
  const keys = row.intended ? await openIntended(ring, scopeOf(row), row.id, row.intended) : null;
  const key = session.candidate === 0 ? new Uint8Array(16) : (keys?.[0] as Uint8Array);
  let ses: Awaited<ReturnType<typeof authFinish>>;
  try {
    ses = await authFinish(key, 0, unhex(session.rndA), unhex(session.rndB), response.data);
  } catch {
    return endHold(ctx, a, row, 'TAG_PROGRAM_FAILED');
  }
  const base: SessionState = { ...session, ses: sesOf(ses), authAnswer: answer };
  if (session.candidate === 1 && keys)
    return release(ctx, a, ring, hold, ses, base, keys, { keyed: true });
  if (!keys) return fresh(ctx, a, ring, hold, ses, base);
  const probe = await probeBatch(ses);
  const next: Next = { next: 'probe', apdus: probe.apdus, stopOn: '9100' };
  return advance(
    ctx,
    a,
    ring,
    hold,
    { ...base, ses: sesOf(ses), probes: probe.probes, authStep: next },
    next,
  );
}

/** The factory key was refused: the intended K0 may be tried (once, by `/reauth`), or the tag is not for us. */
async function refused(
  ctx: ServiceContext,
  a: ProgramAuthority,
  hold: Hold,
  answer: string,
): Promise<Step> {
  const { row, session } = hold;
  if (!row.intended) return endHold(ctx, a, row, 'TAG_NOT_BLANK', { to: 'failed' });
  if (session.candidate === 1) return endHold(ctx, a, row, 'TAG_PROGRAM_FAILED', { to: 'failed' });
  const next: Next = { next: 'reauth', apdus: [hex(authFirstApdu(0))] };
  const ring = await loadKekRing(ctx.env);
  const g = programGrant(ctx, a, nfcChecks());
  const move = moveProgram(g, row.id, {
    from: ['started'],
    step: 'auth',
    to: 'started',
    toStep: 'reauth',
    now: ctx.clock.now(),
    session: await sealSession(ring, scopeOf(row), row.id, {
      ...session,
      authAnswer: answer,
      authStep: next,
    }),
  });
  if (!changed(await g.commit(), g, move)) throw programError('TAG_PROGRAM_FAILED');
  return asStep(next);
}

/** Opens the script of a tag with no keys yet: the keys are drawn, sealed and stored in the statement that releases it. */
async function fresh(
  ctx: ServiceContext,
  a: ProgramAuthority,
  ring: KekRing,
  hold: Hold,
  ses: Awaited<ReturnType<typeof authFinish>>,
  base: SessionState,
): Promise<Step> {
  const { row } = hold;
  const meta = await metaKeyOf(ctx, scopeOf(row), row.keyVersion);
  if (!meta) return endHold(ctx, a, row, 'TAG_PROGRAM_FAILED', { to: 'failed' });
  const keys = newKeys(meta);
  return release(ctx, a, ring, hold, ses, base, keys, {
    keyed: false,
    intended: await sealIntended(ring, scopeOf(row), row.id, keys),
  });
}

async function release(
  ctx: ServiceContext,
  a: ProgramAuthority,
  ring: KekRing,
  hold: Hold,
  ses: Awaited<ReturnType<typeof authFinish>>,
  base: SessionState,
  keys: Uint8Array[],
  how: { keyed: boolean; intended?: Awaited<ReturnType<typeof sealIntended>> },
): Promise<Step> {
  const { row } = hold;
  const keyset = await programKeyset(ctx.env.DB, row.orgId, row.mode, row.keysetId);
  if (!keyset) return endHold(ctx, a, row, 'TAG_PROGRAM_FAILED');
  const script = await scriptBatch(ses, {
    keys,
    version: row.keyVersion,
    host: new URL(ctx.env.PUBLIC_BASE_URL).host,
    slug: keyset.slug,
    old: [],
    keyed: how.keyed,
  });
  const next: Next = { next: 'script', apdus: script.apdus, stopOn: '9100' };
  return advance(
    ctx,
    a,
    ring,
    hold,
    { ...base, ses: sesOf(ses), expect: script.expect, authStep: next },
    next,
    how.intended,
  );
}

/** One compare-and-set to `scripted`: a call that lost the race to a repeat of itself gets the winner's answer. */
async function advance(
  ctx: ServiceContext,
  a: ProgramAuthority,
  ring: KekRing,
  hold: Hold,
  state: SessionState,
  next: Next,
  intended?: Awaited<ReturnType<typeof sealIntended>>,
): Promise<Step> {
  const { row } = hold;
  const g = programGrant(ctx, a, nfcChecks());
  const move = moveProgram(g, row.id, {
    from: ['started'],
    step: 'auth',
    to: 'scripted',
    toStep: next.next === 'probe' ? 'probe' : 'result',
    now: ctx.clock.now(),
    session: await sealSession(ring, scopeOf(row), row.id, state),
    ...(intended ? { intended } : {}),
  });
  if (!changed(await g.commit(), g, move)) throw programError('TAG_PROGRAM_FAILED');
  return asStep(next);
}

/**
 * The answers to the probe (GetKeyVersion for keys 1 to 4): which slots already hold the intended key, which
 * still the factory zeros. Then the script, with each ChangeKey given the key its slot holds now.
 */
export async function probeProgram(
  ctx: ServiceContext,
  a: ProgramAuthority,
  id: string,
  req: z.infer<typeof TagProgramProbeSchema>,
): Promise<Step> {
  const hold = await loadHold(ctx, a, id);
  const { row, session } = hold;
  const answers = lower(req.responses);
  if (session.scriptStep && sameList(session.probeAnswer, answers))
    return asStep(session.scriptStep);
  if (row.state !== 'scripted' || row.step !== 'probe' || !session.probes || !row.intended)
    throw programError('TAG_PROGRAM_FAILED');
  const ses = sessionOf(session);
  const checked = await checkBatch(
    ses,
    session.probes.map((ctr) => ({ ctr, kind: 'mac' as const })),
    answers,
  );
  if (!checked.ok)
    return endHold(ctx, a, row, checked.why === 'short' ? 'TAG_MOVED' : 'TAG_PROGRAM_FAILED');
  const ring = await loadKekRing(ctx.env);
  const keys = await openIntended(ring, scopeOf(row), row.id, row.intended);
  const old = oldKeysFromProbe(checked.bodies, keys, row.keyVersion);
  if (!old) return endHold(ctx, a, row, 'TAG_PROGRAM_FAILED', { to: 'failed' });
  const keyset = await programKeyset(ctx.env.DB, row.orgId, row.mode, row.keysetId);
  if (!keyset) return endHold(ctx, a, row, 'TAG_PROGRAM_FAILED');
  const script = await scriptBatch(ses, {
    keys,
    version: row.keyVersion,
    host: new URL(ctx.env.PUBLIC_BASE_URL).host,
    slug: keyset.slug,
    old,
    keyed: false,
  });
  const next: Next = { next: 'script', apdus: script.apdus, stopOn: '9100' };
  const g = programGrant(ctx, a, nfcChecks());
  const move = moveProgram(g, row.id, {
    from: ['scripted'],
    step: 'probe',
    to: 'scripted',
    toStep: 'result',
    now: ctx.clock.now(),
    session: await sealSession(ring, scopeOf(row), row.id, {
      ...session,
      ses: sesOf(ses),
      old: old.map(hex),
      probeAnswer: answers,
      scriptStep: next,
      expect: script.expect,
    }),
  });
  if (!changed(await g.commit(), g, move)) throw programError('TAG_PROGRAM_FAILED');
  return asStep(next);
}

/**
 * The tag's answer to a second auth part 1, for the intended K0. Auth part 2 under that key is the second (and
 * last) key this hold tries; it counts as an attempt, and the cap refuses it.
 */
export async function reauthProgram(
  ctx: ServiceContext,
  a: ProgramAuthority,
  id: string,
  req: z.infer<typeof TagProgramReauthSchema>,
): Promise<z.infer<typeof TagProgramReauthedSchema>> {
  const hold = await loadHold(ctx, a, id);
  const { row, session } = hold;
  const answer = (req.responses[0] as string).toLowerCase();
  if (session.candidate === 1 && row.step === 'auth' && session.auth1 === answer)
    return { apdus: [session.part2] };
  if (row.state !== 'started' || row.step !== 'reauth' || !row.intended)
    throw programError('TAG_PROGRAM_FAILED');
  if (row.attempts >= ATTEMPT_CAP)
    return endHold(ctx, a, row, 'TAG_PROGRAM_FAILED', { to: 'failed' });
  let response: ReturnType<typeof splitResponse>;
  const ring = await loadKekRing(ctx.env);
  const keys = await openIntended(ring, scopeOf(row), row.id, row.intended);
  const rndA = randomBytes(16);
  let part2: Awaited<ReturnType<typeof authPart2>>;
  try {
    response = splitResponse(unhex(answer));
    if (response.sw !== SW.more) return endHold(ctx, a, row, 'TAG_PROGRAM_FAILED');
    part2 = await authPart2(keys[0] as Uint8Array, response.data, rndA);
  } catch (error) {
    return endHold(ctx, a, row, mapNtag(error).code as 'TAG_PROGRAM_FAILED');
  }
  const state: SessionState = {
    by: actorKeyOf(a),
    idem: session.idem,
    candidate: 1,
    auth1: answer,
    rndA: hex(rndA),
    rndB: hex(part2.rndB),
    part2: hex(part2.apdu),
  };
  const g = programGrant(ctx, a, nfcChecks());
  const move = moveProgram(g, row.id, {
    from: ['started'],
    step: 'reauth',
    to: 'started',
    toStep: 'auth',
    now: ctx.clock.now(),
    session: await sealSession(ring, scopeOf(row), row.id, state),
    attempt: { cap: ATTEMPT_CAP },
  });
  if (!changed(await g.commit(), g, move)) throw programError('TAG_PROGRAM_FAILED');
  return { apdus: [state.part2] };
}

/**
 * The device lost the tag, gave up or timed out. The row goes to `interrupted` and its session is cleared; the
 * responses are not read (they are the device's word, and the next hold probes the tag itself).
 */
export async function abortProgram(
  ctx: ServiceContext,
  a: ProgramAuthority,
  id: string,
  req: z.infer<typeof TagProgramAbortSchema>,
): Promise<{ state: 'interrupted' }> {
  const known = await programById(ctx.env.DB, a.orgId, a.mode, id);
  if (known?.state === 'interrupted') return { state: 'interrupted' };
  const { row } = await loadHold(ctx, a, id, { lenient: true });
  const g = programGrant(ctx, a, nfcChecks());
  moveProgram(g, row.id, {
    from: ['started', 'scripted'],
    to: 'interrupted',
    toStep: 'auth',
    now: ctx.clock.now(),
    errorCode:
      req.why === 'timeout' ? 'TAG_PROGRAM_EXPIRED' : req.why === 'lost' ? 'TAG_MOVED' : null,
    session: null,
  });
  grantedAudit(g, ctx, programAudit(a, row, 'nfc_tag.program_failed', { code: req.why }), [
    exists('nfc_tag_programs', { id: row.id, state: 'interrupted' }),
  ]);
  await g.commit();
  return { state: 'interrupted' };
}
