import type { z } from 'zod';
import type {
  TagProgramAuthSchema,
  TagProgramStepSchema,
} from '../../../shared/contracts/nfc-tag-programs.ts';
import { type KekRing, loadKekRing } from '../../platform/crypto.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { SW, splitResponse } from './ntag424/apdu.ts';
import { authFinish, authFirstApdu } from './ntag424/ev2.ts';
import {
  actorKeyOf,
  endHold,
  guarded,
  type Hold,
  loadHold,
  nfcChecks,
  scopeOf,
} from './program-hold.ts';
import { metaKeyOf, newKeys } from './program-keys.ts';
import { mapNtag, programError } from './program-recover.ts';
import { probeBatch, scriptBatch, sesOf } from './program-script.ts';
import {
  hex,
  type Next,
  openIntended,
  type SessionState,
  sealIntended,
  sealSession,
  unhex,
} from './program-seal.ts';
import { type ProgramAuthority, programGrant, programKeyset } from './repo-programs.ts';
import { changed, moveProgram } from './repo-programs-write.ts';

type Step = z.infer<typeof TagProgramStepSchema>;

const _lower = (list: string[]) => list.map((x) => x.toLowerCase());
const _sameList = (a: string[] | undefined, b: string[]) =>
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
  const probe = await guarded(ctx, a, row, () => probeBatch(ses));
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
    fence: row.session,
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
  const script = await guarded(ctx, a, row, () =>
    scriptBatch(ses, {
      keys,
      version: row.keyVersion,
      host: new URL(ctx.env.PUBLIC_BASE_URL).host,
      slug: keyset.slug,
      old: [],
      keyed: how.keyed,
    }),
  );
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
    fence: row.session,
    ...(intended ? { intended, releasedBy: actorKeyOf(a) } : {}),
  });
  if (!changed(await g.commit(), g, move)) throw programError('TAG_PROGRAM_FAILED');
  return asStep(next);
}
