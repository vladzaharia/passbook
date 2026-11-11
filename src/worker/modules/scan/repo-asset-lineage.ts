import type { SqlValue } from '../../platform/db.ts';
import { safeEqual } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { ScanActor } from './actor.ts';
import {
  type ActorCsrfSnapshot,
  actorCsrfAuthorityStmt,
  actorCsrfSnapshotFence,
  actorCsrfSnapshotFromResult,
} from './actor-csrf.ts';
import { captureAssetGrantCsrf, captureAssetGrantGuard } from './asset-authority.ts';
import { assetSnapshotInput, assetSnapshotProofFromInput } from './asset-secrets.ts';
import type { AssetGuardPlan, AssetPassSnapshot } from './asset-types.ts';
import { snapshotCredentialEnv } from './credential-input.ts';
import {
  type AssetAuthorityGroups,
  actorMatchesPass,
  assetGrantPredicate,
  denied,
} from './repo-asset-lineage-predicate.ts';
import { nonempty } from './repo-asset-session-authority.ts';

export interface AssetGrantGuardInput extends AssetGuardPlan {
  storedGrant?: { tokenHash: string; expiresAt: number; credentialRefsJson: string };
}

type Predicate = { sql: string; params: SqlValue[] };

/** Ephemeral results from actorCsrfAuthorityStmt; never include them in a prepared plan. */
export interface AssetGrantCsrfResults {
  recipient?: D1Result;
  source?: D1Result;
  recipientSnapshot?: ActorCsrfSnapshot;
  sourceSnapshot?: ActorCsrfSnapshot;
}

export interface AssetGrantGuardParts {
  authority: Predicate;
  csrf: Predicate;
  checks: Predicate[];
}

/**
 * Verify the CSRF proofs once, retaining the raw scalars only in this request-local
 * closure. The caller supplies a fresh clock immediately before its final SQL.
 */
export async function prepareAssetGrantGuardParts(
  ctx: ServiceContext,
  input: AssetGrantGuardInput,
  results: AssetGrantCsrfResults | undefined,
  originalSnapshot: AssetPassSnapshot,
): Promise<((now: number) => AssetGrantGuardParts) | null> {
  const pinned = { ...ctx, env: snapshotCredentialEnv(ctx.env) };
  if (
    !input ||
    Object.hasOwn(input, 'snapshot') ||
    !originalSnapshot ||
    !originalSnapshot.pass ||
    !nonempty(input.passId) ||
    input.passId !== originalSnapshot.pass.id ||
    typeof input.snapshotProof !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(input.snapshotProof) ||
    !input.actor ||
    !Array.isArray(input.credentialTombstoneRefs) ||
    !actorMatchesPass(input.actor, originalSnapshot) ||
    (input.recipientSession && Object.hasOwn(input.recipientSession, 'csrf_secret')) ||
    (input.sourceSession && Object.hasOwn(input.sourceSession, 'csrf_secret')) ||
    (input.source !== undefined &&
      (!input.source?.actor || !actorMatchesPass(input.source.actor, originalSnapshot)))
  )
    return null;
  const captured = captureAssetGrantGuard(input);
  const csrfResults = captureAssetGrantCsrf(results);
  let capturedInput: string;
  try {
    capturedInput = assetSnapshotInput(originalSnapshot);
    const proof = await assetSnapshotProofFromInput(pinned.env, capturedInput);
    if (!(await safeEqual(captured.snapshotProof, proof))) return null;
  } catch {
    return null;
  }
  const load = async (
    actor: ScanActor,
    supplied: D1Result | undefined,
    snapshot: ActorCsrfSnapshot | undefined,
    preloaded: boolean,
    role: 'recipient' | 'source',
  ) => {
    if (snapshot) return actorCsrfSnapshotFence(actor, snapshot, role) ? snapshot : null;
    const query = preloaded ? null : actorCsrfAuthorityStmt(pinned.env.DB, actor);
    return actorCsrfSnapshotFromResult(pinned, actor, preloaded ? supplied : await query?.all());
  };
  const [recipient, source] = await Promise.all([
    load(
      captured.actor,
      csrfResults?.recipient,
      csrfResults?.recipientSnapshot,
      csrfResults !== undefined,
      'recipient',
    ),
    captured.source
      ? load(
          captured.source.actor,
          csrfResults?.source,
          csrfResults?.sourceSnapshot,
          csrfResults !== undefined,
          'source',
        )
      : Promise.resolve(null),
  ]);
  if (!recipient || (captured.source && !source)) return null;
  const fence = (
    actor: ScanActor,
    snapshot: ActorCsrfSnapshot,
    role: 'recipient' | 'source',
    now: number,
  ) =>
    actorCsrfSnapshotFence(
      actor,
      {
        ...snapshot,
        session: snapshot.session ? { ...snapshot.session, now } : null,
      },
      role,
    );
  return (now) => {
    let guard: AssetAuthorityGroups;
    try {
      guard = assetGrantPredicate({ ...captured, snapshot: originalSnapshot }, now);
      if (assetSnapshotInput(originalSnapshot) !== capturedInput)
        return { authority: denied(), csrf: denied(), checks: [denied()] };
    } catch {
      return { authority: denied(), csrf: denied(), checks: [denied()] };
    }
    const recipientFence = fence(captured.actor, recipient, 'recipient', now);
    const sourceFence =
      source && captured.source
        ? fence(captured.source.actor, source, 'source', now)
        : { sql: '1', params: [] };
    if (!recipientFence || !sourceFence)
      return { authority: denied(), csrf: denied(), checks: [denied()] };
    const sourceAuthority = captured.source
      ? `EXISTS (SELECT 1 FROM passes p WHERE p.id=?/* scan-ephemeral-pass-id */ AND (${guard.source.sql}))`
      : '1';
    const forPass = (predicate: Predicate): Predicate => ({
      sql: `EXISTS (SELECT 1 FROM passes p WHERE p.id=?/* scan-ephemeral-pass-id */ AND (${predicate.sql}))`,
      params: [captured.passId, ...predicate.params],
    });
    return {
      authority: {
        sql: `(${guard.pass.sql}) AND (${guard.recipient.sql})`,
        params: [...guard.pass.params, ...guard.recipient.params],
      },
      csrf: {
        sql: `(${sourceAuthority}) AND (${recipientFence.sql}) AND (${sourceFence.sql})`,
        params: [
          ...(captured.source ? [captured.passId, ...guard.source.params] : []),
          ...recipientFence.params,
          ...sourceFence.params,
        ],
      },
      checks: [
        forPass(guard.pass),
        forPass(guard.recipient),
        ...(captured.source ? [forPass(guard.source)] : []),
        recipientFence,
        ...(captured.source ? [sourceFence] : []),
      ],
    };
  };
}
