import type { z } from 'zod';
import type {
  TagProgramAbortSchema,
  TagProgramProbeSchema,
  TagProgramReauthedSchema,
  TagProgramReauthSchema,
  TagProgramStepSchema,
} from '../../../shared/contracts/nfc-tag-programs.ts';
import { exists } from '../../platform/authority-cond.ts';
import { loadKekRing } from '../../platform/crypto.ts';
import { randomBytes } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { grantedAudit } from '../audit/repo-granted.ts';
import { SW, splitResponse } from './ntag424/apdu.ts';
import { authPart2 } from './ntag424/ev2.ts';
import {
  actorKeyOf,
  endHold,
  guarded,
  loadHold,
  nfcChecks,
  notFound,
  programAudit,
  scopeOf,
} from './program-hold.ts';
import { ATTEMPT_CAP, mapNtag, oldKeysFromProbe, programError } from './program-recover.ts';
import { checkBatch, scriptBatch, sesOf, sessionOf } from './program-script.ts';
import {
  hex,
  type Next,
  openIntended,
  type SessionState,
  sealSession,
  unhex,
} from './program-seal.ts';
import {
  type ProgramAuthority,
  programById,
  programGrant,
  programKeyset,
} from './repo-programs.ts';
import { changed, moveProgram } from './repo-programs-write.ts';

type Step = z.infer<typeof TagProgramStepSchema>;

const lower = (list: string[]) => list.map((x) => x.toLowerCase());
const sameList = (a: string[] | undefined, b: string[]) =>
  a !== undefined && a.length === b.length && a.every((x, i) => x === b[i]);
const asStep = (n: Next): Step => n as Step;

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
  const ses = await guarded(ctx, a, row, () => sessionOf(session));
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
  const script = await guarded(ctx, a, row, () =>
    scriptBatch(ses, {
      keys,
      version: row.keyVersion,
      host: new URL(ctx.env.PUBLIC_BASE_URL).host,
      slug: keyset.slug,
      old,
      keyed: false,
    }),
  );
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
    fence: row.session,
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
    fence: row.session,
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
  if (known && known.state !== 'started' && known.state !== 'scripted') {
    // Only the hold's own actor, or a Manager, may ask about a row that has already rested.
    const mine = [known.actorKey, known.releasedBy].includes(actorKeyOf(a));
    if (known.state !== 'interrupted' || !(mine || a.manager)) throw notFound();
    return { state: 'interrupted' };
  }
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
    fence: row.session,
  });
  grantedAudit(g, ctx, programAudit(a, row, 'nfc_tag.program_failed', { code: req.why }), [
    exists('nfc_tag_programs', { id: row.id, state: 'interrupted' }),
  ]);
  await g.commit();
  return { state: 'interrupted' };
}
