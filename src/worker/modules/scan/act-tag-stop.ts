import type { ServiceContext } from '../../platform/service-context.ts';
import { type ActRequestInput, claimOf } from './act-claim.ts';
import { claimGrant, claimOnGrant, sunSeenOnGrant, tagSeenOnGrant } from './act-claim-grant.ts';
import { StaleScanAuthority } from './act-override.ts';
import { finishStop } from './act-stop.ts';
import type { ScanActor } from './actor.ts';
import type { CredentialTombstoneSnapshot } from './credential-input.ts';
import { failScanStmt } from './repo-scans.ts';
import type { Stop } from './resolve.ts';
import type { ScanEvaluation } from './scan-evaluation.ts';
import type { TagStop } from './tag-scan.ts';

/** A tag that names no pass: the claim carries only the method. */
const NO_PASS = { passId: '', method: 'nfc' } as const;

/**
 * A tag refused before any pass is recorded like a passless refusal: a claimed scan row closed with the
 * reason, no pass and the tag where it is known. A lost or retired tag at a door is a security signal, and
 * an unknown tag is the desk's prompt to assign it. An unknown tag counts as a miss in the same grant.
 */
export async function recordTagStop(
  ctx: ServiceContext,
  actor: ScanActor,
  request: ActRequestInput,
  requestHash: string,
  credentials: CredentialTombstoneSnapshot,
  stop: TagStop,
): Promise<ScanEvaluation> {
  const req = { ...request, input: NO_PASS };
  const scanId = ctx.ids.ordered();
  const claim = {
    ...claimOf(ctx, actor, req, scanId, requestHash),
    tagId: stop.tagId,
    ...(stop.sun ? { sun: stop.sun } : {}),
  };
  const g = claimGrant(ctx, actor, claim);
  const claimed = claimOnGrant(g, claim);
  tagSeenOnGrant(g, claim);
  sunSeenOnGrant(g, claim);
  const writes = await g.commit();
  const acquired = writes[g.indexOf(claimed)]?.results?.[0] as { at?: unknown } | undefined;
  // The same key claimed in between: its own request answers it.
  if (typeof acquired?.at !== 'number') throw new StaleScanAuthority();
  const claimAt = acquired.at;
  // A test tag on a live scanner is recorded as not found, as a test pass is.
  const recorded =
    stop.reason === 'test_pass' || stop.reason === 'live_pass' ? 'not_found' : stop.reason;
  const refusal: Stop = {
    stop: true,
    kind: 'refused',
    reason: recorded,
    pass: null,
    ref: null,
    at: null,
    flags: [],
    found: null,
  };
  let failureCommitted = false;
  try {
    const outcome = await finishStop(
      {
        ctx,
        actor,
        scanId,
        ownedClaim: claim,
        claimAt,
        method: 'nfc',
        idempotencyKey: request.idempotencyKey,
        requestHash,
        credentialTombstoneRefs: credentials.credentialTombstoneRefs,
        credentialKeysetCommitment: credentials.credentialKeysetCommitment,
        photo: null,
        countMiss: stop.miss,
        ...(request.dayStart === undefined ? {} : { dayStart: request.dayStart }),
        action: null,
        overrideOf: null,
        onFailureCommitted: () => {
          failureCommitted = true;
        },
      },
      refusal,
      { actor, event: null, passFence: null },
    );
    return {
      outcome: { ...outcome, reason: stop.reason },
      evaluatedSnapshot: null,
      credentialContext: credentials,
    };
  } catch (error) {
    if (!failureCommitted)
      await failScanStmt(ctx.env.DB, scanId, { at: claimAt, observedAmbiguous: false }).run();
    throw error;
  }
}
