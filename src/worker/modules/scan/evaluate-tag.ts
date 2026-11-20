import type { TagRead } from '../../../shared/contracts/nfc-tags.ts';
import type { ScanReason } from '../../../shared/contracts/scan.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { candidateTypeFit, sessionTakesType } from '../nfc/policy.ts';
import { type SunSeen, sunFollowupFrom, sunStoredFrom, sunStoredStmt } from '../nfc/repo-sun.ts';
import { assuranceOfSystem, recogniseTag } from '../nfc/systems/registry.ts';
import type { TagEnv } from '../nfc/systems/types.ts';
import { UID_SYSTEM } from '../nfc/systems/uid.ts';
import type { ScanActor } from './actor.ts';
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
import { candidateTakesTag, levelAllows } from './tag-assurance.ts';
import { sunFollowupStmt, sunUse, type TagId } from './tags-sun.ts';

/** Step 1: a fixed UID is a tag; a SUN URL is a Secure tag (verified next); other NDEF text is a pass code. */
export function tagReadOf(
  read: TagRead,
  env: TagEnv,
): { uid: string } | { sun: true } | { code: string } | null {
  const found = recogniseTag(read, env);
  if (found?.system === 'uid') return { uid: found.uid };
  if (found?.system === 'sun') return { sun: true };
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
  | { stop: ScanReason; unknown?: true; tagId?: string; sun?: SunSeen }
  | {
      stop: null;
      tag: TagState & { binding: NonNullable<TagState['binding']> };
      candidates: Candidate[];
      inside: Set<string>;
      overridden: string | null;
      /** A SUN read: what the act that uses it consumes. */
      sun: SunSeen | null;
    };

/** Steps 2-4 in one batch: the org switch, the tag and its binding, the other mode, and the candidates. */
export async function planTagReads(
  ctx: ServiceContext,
  actor: ScanActor,
  id: TagId,
  refs: CredentialTombstoneSnapshot,
  overrideOf?: string,
  /** An act: a SUN read its own device's heads-up already used may be presented once more. */
  followUp = false,
): Promise<TagPlan> {
  const db = ctx.env.DB;
  const other = actor.mode === 'live' ? 'test' : 'live';
  const sun = 'sun' in id ? id.sun : null;
  // A SUN read of the other mode never gets here (its keyset says so); its UID is not asked for again.
  const [own, otherRef] = sun
    ? [sun, sun]
    : await Promise.all([
        UID_SYSTEM.identify(ctx.env, actor.orgId, actor.mode, (id as { uid: string }).uid),
        UID_SYSTEM.identify(ctx.env, actor.orgId, other, (id as { uid: string }).uid),
      ]);
  const sessionId = actor.scanningSession?.id;
  const stmts: D1PreparedStatement[] = [
    tagsSwitchStmt(db, actor.orgId),
    tagStateStmt(db, actor.orgId, actor.mode, own.ref),
    otherModeTagStmt(db, actor.orgId, other, otherRef.ref),
    tagCandidatesStmt(db, actor.orgId, actor.mode, own.ref),
  ];
  const sunAt = sun ? stmts.length : -1;
  if (sun) stmts.push(sunStoredStmt(db, actor.orgId, actor.mode, own.ref));
  const followAt = sun && followUp ? stmts.length : -1;
  if (sun && followUp) stmts.push(sunFollowupStmt(ctx, actor, own.ref, sun));
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
      // A UID read of a Secure tag, or a SUN read of a Basic one, is never the tag (TS7).
      if (tag.system !== (sun ? 'sun' : 'uid')) return { stop: 'tag_invalid', tagId };
      // From here a SUN read is the tag's own, newer than its last use: a refusal that names the tag uses it.
      let seen: SunSeen | undefined;
      if (sun) {
        const used = sunUse(ctx, actor.orgId, sun, sunStoredFrom(results[sunAt]), {
          scanId: followAt < 0 ? null : sunFollowupFrom(results[followAt]),
          overrideOf,
        });
        if ('refused' in used) {
          ctx.log.info('scan.tag_refused', { orgId: actor.orgId, code: used.refused });
          return { stop: 'tag_invalid', tagId };
        }
        seen = used.seen;
      }
      // A follow-up uses nothing new, so a refusal after it records no counter.
      const halt = (reason: ScanReason): TagFound => ({
        stop: reason,
        tagId,
        ...(seen && !seen.followUp ? { sun: seen } : {}),
      });
      const assurance = assuranceOfSystem(tag.system);
      // The session's level: a Secure-only door never takes a Basic tag, whatever the template says.
      if (!levelAllows(actor.settings.tags?.level, assurance)) {
        ctx.log.info('scan.tag_refused', { orgId: actor.orgId, code: 'TAG_LEVEL_LOW' });
        return halt('tag_not_allowed');
      }
      if (tag.status !== 'active') {
        ctx.log.info('scan.tag_refused', { orgId: actor.orgId, code: 'TAG_RETIRED' });
        return halt('not_found');
      }
      if (tag.lostAt !== null) return halt('tag_lost');
      const binding = tag.binding;
      if (!binding) return halt('not_found');
      if (binding.scope === 'user' && !binding.userActive) {
        ctx.log.info('scan.tag_refused', { orgId: actor.orgId, code: 'TAG_USER_DISABLED' });
        return halt('not_found');
      }
      // The assignment ended by itself (the type's `binding_days`): the tag is a spare, and the door says so.
      if (binding.expiresAt !== null && binding.expiresAt <= ctx.clock.now()) {
        ctx.log.info('scan.tag_refused', { orgId: actor.orgId, code: 'TAG_EXPIRED' });
        return halt('tag_expired');
      }
      // The session's types: a door that names the types it takes refuses a tag of any other (`standard`: none).
      if (!sessionTakesType(actor.settings.tags?.types, tag.type)) {
        ctx.log.info('scan.tag_refused', { orgId: actor.orgId, code: 'TAG_TYPE_NOT_ALLOWED' });
        return halt('tag_not_allowed');
      }
      let candidates = candidatesOf(results[3]);
      if (candidates.some((c) => c.credentialKeysetCommitment !== refs.credentialKeysetCommitment))
        return halt('not_found');
      for (const c of candidates) Object.assign(c, refs);
      // A pending transfer is not ownership yet (review-t1 I4); a pass binding keeps today's answer.
      if (binding.scope === 'user') candidates = candidates.filter((c) => !c.transferPending);
      if (!candidates.length) return halt('not_found');
      // A template that asks for a stronger tag than this one is never admitted on it.
      candidates = candidates.filter((c) => candidateTakesTag(ctx, c, assurance));
      if (!candidates.length) {
        ctx.log.info('scan.tag_refused', { orgId: actor.orgId, code: 'TAG_ASSURANCE_LOW' });
        return halt('tag_not_allowed');
      }
      // A pass of a template the type does not name, or whose uses leave the type's use out, never takes this tag.
      candidates = candidates.filter((c) => candidateTypeFit(c, tag.type) === 'ok');
      if (!candidates.length) {
        ctx.log.info('scan.tag_refused', { orgId: actor.orgId, code: 'TAG_TYPE_MISMATCH' });
        return halt('tag_not_allowed');
      }
      const overridden =
        overrideAt < 0 ? null : (passIdsOf(results[overrideAt]).values().next().value ?? null);
      return {
        stop: null,
        tag: { ...tag, binding },
        candidates,
        inside: insideAt < 0 ? new Set() : passIdsOf(results[insideAt]),
        overridden,
        sun: seen ?? null,
      };
    },
  };
}
