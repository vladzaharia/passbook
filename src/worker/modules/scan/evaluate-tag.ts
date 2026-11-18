import type { ScanTag, TagRead } from '../../../shared/contracts/nfc-tags.ts';
import type { ScanReason } from '../../../shared/contracts/scan.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { readableUid, tagRef } from '../nfc/tag-ref.ts';
import { isGuestPass } from './access.ts';
import type { ScanActor, ScanTagAuthority } from './actor.ts';
import type { CredentialTombstoneSnapshot } from './credential-input.ts';
import { type Candidate, candidatesOf } from './repo-lookup.ts';
import {
  otherModeTagStmt,
  overriddenPassStmt,
  passIdsOf,
  type TagState,
  tagCandidatesStmt,
  tagInsideStmt,
  tagStateOf,
  tagStateStmt,
  tagsOn,
  tagsSwitchStmt,
} from './repo-tags-resolve.ts';
import { accepts, matchesEvent } from './resolve-candidates.ts';
import { evaluate } from './resolve-evaluate.ts';
import { candidateTakesTag, TAG_ASSURANCE } from './tag-assurance.ts';
import { resolveCandidateReadTemplates } from './template-read-snapshot.ts';

/** At most this many of a user's passes are evaluated for one tag read (design §3.5). */
const EVALUATED = 4;

/** Step 1: a fixed UID is a tag; a read with only NDEF text is a pass code on today's path. */
export function tagReadOf(read: TagRead): { uid: string } | { code: string } | null {
  const uid = readableUid(read);
  if (uid) return { uid };
  if (read.ndef) return { code: read.ndef.value };
  return null;
}

export interface TagPlan {
  /** The keyed ref of the tag in the actor's mode; the request hash names it, never the UID. */
  ref: string;
  stmts: D1PreparedStatement[];
  read(results: readonly D1Result[]): TagFound;
}

export type TagFound =
  | { stop: ScanReason; unknown?: true; tagId?: string }
  | {
      stop: null;
      tag: TagState & { binding: NonNullable<TagState['binding']> };
      candidates: Candidate[];
      inside: Set<string>;
      overridden: string | null;
    };

/** Steps 2-4 in one batch: the org switch, the tag and its binding, the other mode, and the candidates. */
export async function planTagReads(
  ctx: ServiceContext,
  actor: ScanActor,
  uid: string,
  refs: CredentialTombstoneSnapshot,
  overrideOf?: string,
): Promise<TagPlan> {
  const db = ctx.env.DB;
  const other = actor.mode === 'live' ? 'test' : 'live';
  const [own, otherRef] = await Promise.all([
    tagRef(ctx.env, actor.orgId, actor.mode, uid),
    tagRef(ctx.env, actor.orgId, other, uid),
  ]);
  const sessionId = actor.scanningSession?.id;
  const stmts = [
    tagsSwitchStmt(db, actor.orgId),
    tagStateStmt(db, actor.orgId, actor.mode, own.ref),
    otherModeTagStmt(db, actor.orgId, other, otherRef.ref),
    tagCandidatesStmt(db, actor.orgId, actor.mode, own.ref),
  ];
  // Read on every door with tracked zones: an exit prefers the pass inside, an entry stops at it.
  const insideAt = sessionId ? stmts.length : -1;
  if (sessionId) stmts.push(tagInsideStmt(db, actor.orgId, actor.mode, own.ref, sessionId));
  const overrideAt = overrideOf ? stmts.length : -1;
  if (overrideOf) stmts.push(overriddenPassStmt(db, actor.orgId, actor.mode, overrideOf));
  return {
    ref: own.ref,
    stmts,
    read(results) {
      const tag = tagStateOf(results[1]);
      if (!tagsOn(results[0]))
        return tag ? { stop: 'tag_not_allowed', tagId: tag.id } : { stop: 'tag_not_allowed' };
      if (!tag) {
        if (results[2]?.results?.length)
          return { stop: actor.mode === 'live' ? 'test_pass' : 'live_pass' };
        return { stop: 'not_found', unknown: true };
      }
      const tagId = tag.id;
      if (tag.kind !== 'uid') return { stop: 'tag_invalid', tagId };
      if (tag.status !== 'active') {
        ctx.log.info('scan.tag_refused', { orgId: actor.orgId, code: 'TAG_RETIRED' });
        return { stop: 'not_found', tagId };
      }
      if (tag.lostAt !== null) return { stop: 'tag_lost', tagId };
      const binding = tag.binding;
      if (!binding) return { stop: 'not_found', tagId };
      if (binding.scope === 'user' && !binding.userActive) {
        ctx.log.info('scan.tag_refused', { orgId: actor.orgId, code: 'TAG_USER_DISABLED' });
        return { stop: 'not_found', tagId };
      }
      let candidates = candidatesOf(results[3]);
      if (candidates.some((c) => c.credentialKeysetCommitment !== refs.credentialKeysetCommitment))
        return { stop: 'not_found', tagId };
      for (const c of candidates) Object.assign(c, refs);
      // A pending transfer is not ownership yet (review-t1 I4); a pass binding keeps today's answer.
      if (binding.scope === 'user') candidates = candidates.filter((c) => !c.transferPending);
      if (!candidates.length) return { stop: 'not_found', tagId };
      // A template that asks for a stronger tag than this one is never admitted on it.
      candidates = candidates.filter((c) => candidateTakesTag(ctx, c));
      if (!candidates.length) {
        ctx.log.info('scan.tag_refused', { orgId: actor.orgId, code: 'TAG_ASSURANCE_LOW' });
        return { stop: 'tag_not_allowed', tagId };
      }
      const overridden =
        overrideAt < 0 ? null : (passIdsOf(results[overrideAt]).values().next().value ?? null);
      return {
        stop: null,
        tag: { ...tag, binding },
        candidates,
        inside: insideAt < 0 ? new Set() : passIdsOf(results[insideAt]),
        overridden,
      };
    },
  };
}

/** Step 5: inside first, active, members before guests, the anchor, oldest, id. */
function ordered(found: Extract<TagFound, { stop: null }>, list: Candidate[]): Candidate[] {
  const rank = (c: Candidate) => [
    found.inside.has(c.pass.id) ? 0 : 1,
    c.pass.status === 'voided' || c.pass.removedAt !== null ? 1 : 0,
    isGuestPass(c) ? 1 : 0,
    c.pass.id === found.tag.binding.passId ? 0 : 1,
    c.pass.createdAt,
  ];
  return [...list].sort((a, b) => {
    const x = rank(a);
    const y = rank(b);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return (x[i] ?? 0) - (y[i] ?? 0);
    return a.pass.id < b.pass.id ? -1 : a.pass.id > b.pass.id ? 1 : 0;
  });
}

export interface TagChoice {
  chosen: Candidate;
  actor: ScanActor;
  /** Desk and Manager only: a Door and customer screens never show tag data (§7.2). */
  view: ScanTag | null;
}

/**
 * Steps 4-7. A pass binding is today's single pass. A user binding never answers `ambiguous`: its passes this
 * scanner takes are evaluated in order; the first valid wins, else the first heads-up, else the first one's
 * refusal. A pin (the pass a resolve showed, a replayed scan's or an overridden scan's) is used as is, and
 * must still be one of the binding's passes.
 */
export async function chooseTagPass(
  ctx: ServiceContext,
  actor: ScanActor,
  found: Extract<TagFound, { stop: null }>,
  options: { pin?: string | null; actionId?: string } = {},
): Promise<TagChoice | null> {
  const { tag } = found;
  const all = found.candidates;
  const choice = (chosen: Candidate, passes?: ScanTag['passes']): TagChoice => {
    const authority: ScanTagAuthority = {
      tagId: tag.id,
      bindingId: tag.binding.id,
      scope: tag.binding.scope,
      userId: tag.binding.userId,
      passId: chosen.pass.id,
    };
    const desk = actor.role === 'desk' || actor.role === 'manager';
    const view: ScanTag | null = desk
      ? { hint: tag.hint, assurance: TAG_ASSURANCE, scope: tag.binding.scope }
      : null;
    if (view && tag.binding.scope === 'user') {
      view.count = all.length;
      if (passes) view.passes = passes;
    }
    return { chosen, actor: { ...actor, tag: authority }, view };
  };
  const pin = options.pin ?? null;
  if (pin !== null) {
    const pinned = all.find((c) => c.pass.id === pin);
    return pinned ? choice(pinned) : null;
  }
  const first = all[0];
  if (!first) return null;
  if (tag.binding.scope === 'pass' || all.length === 1) return choice(first);
  const taken = all.filter((c) => accepts(actor, c.pass));
  const matched = taken.filter((c) => matchesEvent(actor, c.pass));
  // None here: the first pass gives today's not_accepted or wrong_event.
  const ordering = ordered(found, matched);
  if (!ordering.length) return choice(taken[0] ?? first);
  // One fob is one person: a pass already inside answers alone, so a second pass never admits again.
  const inside = ordering[0] && found.inside.has(ordering[0].pass.id);
  const tried = inside ? ordering.slice(0, 1) : ordering;
  const verdicts = new Map<
    string,
    { kind: 'ok' | 'heads_up' | 'refused'; reason: string | null }
  >();
  for (const c of tried.slice(0, EVALUATED)) {
    const input = { passId: c.pass.id, method: 'nfc' as const };
    const refs = {
      credentialKeysetCommitment: c.credentialKeysetCommitment,
      credentialTombstoneRefs: [],
      otherModeCredentialTombstoneRefs: [],
    };
    const evaluated = await evaluate(ctx, actor, input, {}, refs, {
      candidateRead: { candidates: [structuredClone(c)] },
    });
    const lacksAction =
      !evaluated.stop &&
      options.actionId !== undefined &&
      options.actionId !== 'auto' &&
      !evaluated.found.scan.actions.some((a) => a.id === options.actionId);
    verdicts.set(
      c.pass.id,
      evaluated.stop
        ? { kind: evaluated.kind, reason: evaluated.reason }
        : lacksAction
          ? { kind: 'refused', reason: 'not_accepted' }
          : { kind: 'ok', reason: null },
    );
    if (!evaluated.stop && !lacksAction) break;
  }
  const pick =
    tried.find((c) => verdicts.get(c.pass.id)?.kind === 'ok') ??
    tried.find((c) => verdicts.get(c.pass.id)?.kind === 'heads_up') ??
    tried[0];
  if (!pick) return null;
  const passes: NonNullable<ScanTag['passes']> = [
    ...tried.map((c) => {
      const verdict = verdicts.get(c.pass.id);
      const state =
        c === pick
          ? 'used'
          : !verdict
            ? 'unchecked'
            : verdict.kind === 'ok'
              ? 'lets_in'
              : 'refused';
      return {
        passId: c.pass.id,
        templateName: resolveCandidateReadTemplates(c)?.active.manifest.name ?? null,
        state,
        reason: state === 'refused' ? (verdict?.reason ?? null) : null,
      } as const;
    }),
    ...all
      .filter((c) => !tried.includes(c))
      .map(
        (c) =>
          ({
            passId: null,
            templateName: null,
            state: 'not_here',
            reason: taken.includes(c) ? 'wrong_event' : 'not_accepted',
          }) as const,
      ),
  ];
  return choice(pick, passes);
}
