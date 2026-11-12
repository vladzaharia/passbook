import type { Grant } from '../../platform/authority.ts';
import { AuthorityError } from '../../platform/authority-error.ts';
import { writePart } from '../../platform/authority-include.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { credentialRefKeysetInitializeStmt } from '../passes/repo-credential-keyset.ts';
import type { ScanActor } from './guard.ts';
import type { Claim } from './repo-scans.ts';
import { capturedStatement, capturingDb } from './scan-capture.ts';
import { partSql, scanWriteGrant } from './scan-write-grant.ts';

/** Tables the claim batch writes: the claim row and, once, the credential keyset. */
const CLAIM_TABLES = ['scans', 'credential_ref_keyset'];

/** The grant that opens a key's claim. The actor must still be who the guard saw. */
export function claimGrant(ctx: ServiceContext, actor: ScanActor, claim: Claim): Grant {
  return scanWriteGrant(ctx, actor, {
    purpose: 'org_mode.scan.claim',
    now: claim.now,
    tables: CLAIM_TABLES,
  });
}

/**
 * Insert the pending claim, or nothing when the key already has one (the replay read in the same
 * batch tells which). The row comes back with the `at` that owns this generation.
 */
export function claimOnGrant(g: Grant, claim: Claim) {
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
      'idempotency_key',
      'request_hash',
      'method',
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
      claim.idempotencyKey,
      claim.requestHash,
      claim.method,
      'pending',
      claim.clientTs,
      claim.now,
    ],
    { doNothing: true, returning: ['id', 'at'] },
  );
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
  g.include(writePart(partSql(seen.sql), seen.params));
}
