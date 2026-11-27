import type { Grant } from '../../platform/authority.ts';
import { AuthorityError } from '../../platform/authority-error.ts';
import { writePart } from '../../platform/authority-include.ts';
import { splitRaceTag } from '../../platform/race-tag.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import {
  consumeSun,
  FOLLOW_UP_MS,
  markFollowedUp,
  sunFollowCheck,
  sunFreshCheck,
} from '../nfc/repo-sun.ts';
import { credentialRefKeysetInitializeStmt } from '../passes/repo-credential-keyset.ts';
import type { ScanActor } from './guard.ts';
import type { Claim } from './repo-scans.ts';
import { capturedStatement, capturingDb } from './scan-capture.ts';
import { partSql, scanWriteGrant } from './scan-write-grant.ts';

/** Tables the claim batch writes: the claim row and, once, the credential keyset. */
const CLAIM_TABLES = ['scans', 'credential_ref_keyset'];

/**
 * The grant that opens a key's claim. The actor must still be who the guard saw. A SUN read is consumed here:
 * the grant is refused (`TAG_SUN_REPLAY`) unless the read is still newer than the tag's counter.
 */
export function claimGrant(ctx: ServiceContext, actor: ScanActor, claim: Claim): Grant {
  const sun = claim.tagId && claim.sun ? { tagId: claim.tagId, seen: claim.sun } : null;
  return scanWriteGrant(ctx, actor, {
    purpose: 'org_mode.scan.claim',
    now: claim.now,
    tables: [
      ...CLAIM_TABLES,
      ...(claim.tagId ? ['nfc_tags'] : []),
      ...(sun ? ['nfc_tag_sun'] : []),
    ],
    ...(sun
      ? {
          checks: sun.seen.followUp
            ? sunFollowCheck(sun.tagId, sun.seen, actor.actorKey, claim.now - FOLLOW_UP_MS)
            : sunFreshCheck(sun.tagId, sun.seen),
          codes: { stale: 'TAG_SUN_REPLAY' },
        }
      : {}),
  });
}

/**
 * Insert the pending claim, or nothing when the key already has one (the replay read in the same
 * batch tells which). The row comes back with the `at` that owns this generation.
 */
export function claimOnGrant(g: Grant, claim: Claim) {
  // The counter this scan consumed, for its follow-ups. A follow-up consumes none.
  const used = claim.sun && !claim.sun.followUp ? claim.sun : null;
  return g.upsert(
    'scans',
    [
      'id',
      'scanner_id',
      'event_id',
      'actor_type',
      'actor_id',
      'actor_key',
      'staff_id',
      'session_id',
      'api_key_id',
      'override_of',
      'idempotency_key',
      'request_hash',
      'method',
      'tag_id',
      ...(used ? ['sun_ctr', 'sun_key_version'] : []),
      'state',
      'client_ts',
      'at',
    ],
    [
      claim.id,
      claim.scannerId,
      claim.eventId,
      claim.actorType,
      claim.actorId,
      claim.actorKey,
      claim.staffId,
      claim.sessionId ?? null,
      claim.apiKeyId ?? null,
      claim.overrideOf ?? null,
      claim.idempotencyKey,
      claim.requestHash,
      claim.method,
      claim.tagId ?? null,
      ...(used ? [used.ctr, used.keyVersion] : []),
      'pending',
      claim.clientTs,
      claim.now,
    ],
    { doNothing: true, returning: ['id', 'at'] },
  );
}

/** A tag read is seen when its scan is claimed. */
export function tagSeenOnGrant(g: Grant, claim: Claim): void {
  if (claim.tagId)
    g.update('nfc_tags', { set: { last_seen_at: claim.now }, where: { id: claim.tagId } });
}

/**
 * A SUN read is used when its scan is claimed: the tag's counter moves up to it. A follow-up marks its scan
 * followed up instead, once.
 */
export function sunSeenOnGrant(g: Grant, claim: Claim): void {
  if (!claim.tagId || !claim.sun) return;
  if (claim.sun.followUp) markFollowedUp(g, claim.sun.followUp, claim.now);
  else consumeSun(g, claim.tagId, claim.sun, claim.now);
}

/** The one-time keyset initialization rides the claim's grant instead of a claim-proving predicate. */
export function keysetOnGrant(g: Grant, db: D1Database, commitment: string): void {
  const statement = credentialRefKeysetInitializeStmt(capturingDb(db), commitment, {
    sql: '{grant}',
    params: [],
  });
  const seen = capturedStatement(statement);
  if (!seen)
    throw new AuthorityError('GRANT_FOREIGN_STATEMENT', 'The keyset statement was not captured.');
  g.include(writePart(partSql(seen.sql), seen.params, splitRaceTag(seen.sql).tag || undefined));
}
