import type { TagProgramErrorCode } from '../../../shared/contracts/nfc-tag-programs.ts';
import { exists } from '../../platform/authority-cond.ts';
import { entitled } from '../../platform/authority-entitled.ts';
import { loadKekRing } from '../../platform/crypto.ts';
import { NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { grantedAudit } from '../audit/repo-granted.ts';
import type { KeyScope } from './keyset-seal.ts';
import { programError } from './program-recover.ts';
import { openSession, type SessionState } from './program-seal.ts';
import {
  moveProgram,
  type ProgramAuthority,
  type ProgramRow,
  programById,
  programGrant,
} from './repo-programs.ts';

export const actorKeyOf = (a: ProgramAuthority) => `${a.actor.type}:${a.actor.id}`;

export const scopeOf = (row: Pick<ProgramRow, 'orgId' | 'mode' | 'keysetId'>): KeyScope => ({
  orgId: row.orgId,
  mode: row.mode,
  keysetId: row.keysetId,
});

/** A program of the caller's tenant with its session open, for the device that holds it. */
export interface Hold {
  row: ProgramRow;
  session: SessionState;
}

export const notFound = () => new NotFoundError('Tag setup not found.', 'TAG_NOT_FOUND');

/** The audit of a program event: names the scanner or key, never the tag. */
export const programAudit = (
  a: ProgramAuthority,
  row: Pick<ProgramRow, 'id' | 'hint'>,
  action: string,
  detail: Record<string, unknown> = {},
) => ({
  orgId: a.orgId,
  actorType: a.actor.type === 'scanner' ? ('scanner' as const) : ('api_key' as const),
  actorId: a.actor.id,
  action,
  targetType: 'tag_program',
  targetId: row.id,
  detail: { hint: row.hint, ...(a.actor.staffId ? { staffId: a.actor.staffId } : {}), ...detail },
});

/**
 * Ends a hold that did not finish: back to `interrupted` when the row holds intended keys (the tag may hold
 * them too, so the next hold resumes), else `failed`. The session is cleared in the same statement. Always
 * throws the refusal for `code`.
 */
export async function endHold(
  ctx: ServiceContext,
  a: ProgramAuthority,
  row: ProgramRow,
  code: TagProgramErrorCode,
  options: { to?: 'failed' | 'interrupted' } = {},
): Promise<never> {
  const to = options.to ?? (row.intended ? 'interrupted' : 'failed');
  const g = programGrant(ctx, a);
  moveProgram(g, row.id, {
    from: ['started', 'scripted', 'interrupted'],
    to,
    toStep: 'auth',
    now: ctx.clock.now(),
    errorCode: code,
    session: null,
  });
  grantedAudit(g, ctx, programAudit(a, row, 'nfc_tag.program_failed', { code }), [
    exists('nfc_tag_programs', { id: row.id, state: to }),
  ]);
  await g.commit();
  ctx.log.warn('nfc.program.ended', { orgId: row.orgId, code, programId: row.id, hint: row.hint });
  throw programError(code);
}

/** Loads the hold a call continues. A row that is not live, or not this device's, reads as not found. */
export async function loadHold(
  ctx: ServiceContext,
  a: ProgramAuthority,
  id: string,
  options: { lenient?: boolean } = {},
): Promise<Hold> {
  const row = await programById(ctx.env.DB, a.orgId, a.mode, id);
  if (!row) throw notFound();
  if (!row.session || (row.state !== 'started' && row.state !== 'scripted'))
    throw programError('TAG_PROGRAM_FAILED');
  const session = await openSession(await loadKekRing(ctx.env), scopeOf(row), row.id, row.session);
  if (session.by !== actorKeyOf(a)) throw notFound();
  if (!options.lenient && ctx.clock.now() > row.expiresAt)
    return endHold(ctx, a, row, 'TAG_PROGRAM_EXPIRED');
  return { row, session };
}

/** The nfc entitlement, still on: part of every grant that touches a tag. */
export const nfcChecks = () => [entitled('nfc', 'basic')];
