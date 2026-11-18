import type { z } from 'zod';
import type {
  ScanTagInspectResponseSchema,
  TagAssignRoleSchema,
  TagRead,
} from '../../../shared/contracts/nfc-tags.ts';
import type { ScanCodeInput, ScanRole } from '../../../shared/contracts/scan.ts';
import { validityOf } from '../../../shared/pass-view/validity.ts';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { tagsEnabled } from '../nfc/policy.ts';
import { tagByRef, tagView } from '../nfc/repo-tags.ts';
import { readableUid, tagRef } from '../nfc/tag-ref.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import {
  type CredentialTombstoneSnapshot,
  credentialTombstoneRefsForInput,
} from './credential-input.ts';
import type { ScanActor } from './guard.ts';
import type { Candidate } from './repo-lookup.ts';
import { bumpTagCap, passTemplate } from './repo-tags-bind.ts';
import {
  accepts,
  candidateCredentialSnapshotValid,
  candidateWallet,
  findCandidates,
  matchesEvent,
} from './resolve-candidates.ts';
import { ROLE_RANK } from './rules.ts';

type Inspect = z.infer<typeof ScanTagInspectResponseSchema>;
type TagAssignRole = z.infer<typeof TagAssignRoleSchema>;

export interface TagRights {
  role: ScanRole;
  /** Who may bind a tag to the scanned pass, and to the holder as a person. */
  assign: TagAssignRole;
  assignAll: TagAssignRole;
}

/** Desk and up on a scanner, with assigning not turned off. A door, a screen and the console are refused. */
export function tagRights(actor: ScanActor): TagRights & { scannerId: string } {
  const { scanner, role } = actor;
  if (actor.principal !== 'scanner' || !scanner)
    throw new ForbiddenError('Assign tags on a scanner.', 'TAG_SCANNER_ONLY');
  if (role === null || ROLE_RANK[role] < ROLE_RANK.desk)
    throw new ForbiddenError('Tags are assigned by Desk and up.', 'TAG_ASSIGN_FORBIDDEN');
  const assign = actor.settings.tags?.assign ?? 'desk';
  if (assign === 'never')
    throw new ForbiddenError('Assigning tags is off on this scanner.', 'TAG_ASSIGN_FORBIDDEN');
  return {
    role,
    assign,
    assignAll: actor.settings.tags?.assignAll ?? 'manager',
    scannerId: scanner.id,
  };
}

/** The UID a bind needs. */
export function tagUid(read: TagRead): string {
  const uid = readableUid(read);
  if (uid) return uid;
  if (read.uidRandom || (read.uid && readableUid({ uid: read.uid }) === null))
    throw new ValidationError('This tag changes its ID. Try another tag.', [], 'TAG_UID_RANDOM');
  throw new ValidationError("Can't read this tag. Try another tag.", [], 'TAG_UNREADABLE');
}

const BLANK: Omit<Inspect, 'state'> = {
  hint: null,
  assurance: null,
  bound: null,
  lostAt: null,
  boundAt: null,
  boundByName: null,
};

/** What a tag is now. Read only; no counter is used. */
export async function inspectTag(
  ctx: ServiceContext,
  actor: ScanActor,
  read: TagRead,
): Promise<Inspect> {
  const { scannerId } = tagRights(actor);
  const { orgId, mode } = actor;
  const db = ctx.env.DB;
  if (!(await tagsEnabled(ctx, orgId))) return { ...BLANK, state: 'not_allowed' };
  const uid = readableUid(read);
  if (!uid) return { ...BLANK, state: 'invalid' };
  await ensureCredentialRefKeyset(db, ctx.env);
  const { ref, hint } = await tagRef(ctx.env, orgId, mode, uid);
  const tag = await tagByRef(db, orgId, mode, ref);
  if (!tag) {
    await bumpTagCap(db, 'unknown', scannerId, ctx.clock.now());
    return { ...BLANK, state: 'new', hint, assurance: 'basic' };
  }
  const base = { ...BLANK, hint: tag.hint, assurance: 'basic' as const };
  if (tag.status === 'retired') return { ...base, state: 'retired' };
  const binding = (await tagView(db, orgId, mode, tag.id))?.binding ?? null;
  if (binding) {
    // Names only for a pass this scanner takes: a found fob tells a desk nothing about other templates.
    const templateId = await passTemplate(db, binding.passId);
    const takes =
      templateId !== null &&
      (actor.templateIds.length === 0
        ? actor.settings.acceptAllTemplates === true
        : actor.templateIds.includes(templateId));
    return {
      ...base,
      state: 'bound',
      bound: {
        scope: binding.scope,
        passTitle: takes ? (binding.passTitle ?? '') : '',
        holderName: takes ? binding.holderName : null,
      },
      boundAt: binding.boundAt,
      boundByName: takes ? binding.boundByName : null,
    };
  }
  if (tag.lostAt !== null) return { ...base, state: 'lost', lostAt: tag.lostAt };
  return { ...base, state: 'new' };
}

const refused = (reason: 'voided' | 'removed' | 'expired') =>
  new ConflictError(`Can't assign a tag to a ${reason} pass.`, `TAG_PASS_${reason.toUpperCase()}`);
const notFound = () => new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');

/**
 * The one pass a card names, for this org and mode, that this scanner accepts. A voided, removed or expired
 * pass is refused; one that is not valid yet is allowed (pre-registration).
 */
export async function cardPass(
  ctx: ServiceContext,
  actor: ScanActor,
  input: ScanCodeInput,
): Promise<{ candidate: Candidate; refs: CredentialTombstoneSnapshot }> {
  const refs = await credentialTombstoneRefsForInput(ctx, actor.orgId, actor.mode, input);
  const found = await findCandidates(ctx, actor, input, refs);
  const inMode = (found ?? []).filter(
    (c) =>
      c.pass.orgId === actor.orgId &&
      c.pass.mode === actor.mode &&
      c.pass.deletedAt === null &&
      candidateCredentialSnapshotValid(c),
  );
  if (inMode.length === 0) throw notFound();
  const taken = inMode.filter((c) => accepts(actor, c.pass) && matchesEvent(actor, c.pass));
  const [one, ...rest] = taken;
  if (!one)
    throw new ForbiddenError('This scanner does not take that pass.', 'TAG_PASS_NOT_ACCEPTED');
  if (rest.length > 0)
    throw new ConflictError('Several passes match. Scan the card again.', 'TAG_CARD_AMBIGUOUS');
  const { pass } = one;
  if (pass.removedAt !== null) throw refused('removed');
  if (pass.status === 'voided') throw refused('voided');
  const wallet = candidateWallet(one);
  if (!wallet) throw notFound();
  const validity = validityOf(wallet, ctx.clock.now());
  if (validity.status === 'voided') throw refused('voided');
  if (validity.status === 'expired') throw refused('expired');
  return { candidate: one, refs };
}
