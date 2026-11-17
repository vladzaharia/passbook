import type { ScanInput } from '../../../shared/contracts/scan.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { type CredentialTombstoneSnapshot, scanCredentialKeys } from './credential-input.ts';
import type { ScanActor } from './guard.ts';
import { grantReadMiss } from './misses.ts';
import { missWindow } from './repo-miss-authority.ts';
import { scanReadAuthority } from './repo-read-authority.ts';
import { ACTOR_TENANT, type Fence, otherModeSql, refsClear } from './repo-read-fences.ts';
import type { CandidateMatchInput } from './repo-resolve-candidates.ts';
import {
  absent,
  acceptedFilter,
  matchingPassSql,
  passlessStmt,
} from './repo-resolve-passless-read.ts';

export { acceptedFilter, candidateEligible } from './repo-resolve-passless-read.ts';

/** The credential alternatives a code or pass id names, for matching passes. Null: it cleaned to nothing. */
export async function inputMatch(
  ctx: ServiceContext,
  actor: ScanActor,
  input: ScanInput,
  credentials: CredentialTombstoneSnapshot,
): Promise<CandidateMatchInput | null> {
  if ('passId' in input) return { passId: input.passId };
  const keys = await scanCredentialKeys(
    ctx.env,
    actor.orgId,
    actor.mode,
    input.code,
    true,
    credentials,
  );
  return keys.clean
    ? {
        scanCode: keys.scanCode,
        barcodeHash: keys.barcodeHash,
        lookupHash: keys.lookupHash,
        serial: input.method === 'manual' ? keys.clean : null,
      }
    : null;
}

/** What a passless answer must still hold when it is given. */
export interface PasslessSpec {
  /** Keyed refs of the presented credential in the actor's mode. */
  refs: readonly string[] | undefined;
  /** Refs in the other mode, for a cross-mode detection. */
  otherRefs?: readonly string[] | undefined;
  /** A same-mode pass that would change the answer exists: the answer is stale. */
  appeared?: Fence;
  /** Each pass the answer names is still the one it saw. A null fence cannot hold. */
  lineage?: readonly (Fence | null)[];
}

/**
 * One read: the actor's authority holds, the credential is not retired, and nothing the answer
 * rests on moved. Actor-only reasons must not disclose a credential retired since candidate resolution.
 */
export async function passlessCurrent(
  ctx: ServiceContext,
  actor: ScanActor,
  spec: PasslessSpec,
): Promise<boolean> {
  const own = refsClear(spec.refs);
  const other = spec.otherRefs
    ? refsClear(spec.otherRefs, { org: ACTOR_TENANT.org, mode: otherModeSql(actor.mode) })
    : { sql: '1', params: [] };
  if (!own || !other || spec.lineage?.some((fence) => fence === null)) return false;
  const parts: Fence[] = [
    own,
    other,
    ...(spec.appeared ? [absent(spec.appeared)] : []),
    ...(spec.lineage ?? []).flatMap((fence) => (fence ? [fence] : [])),
  ];
  const row = await passlessStmt(
    ctx.env.DB,
    scanReadAuthority(actor, { now: ctx.clock.now() }),
    parts,
  ).first();
  return row !== null;
}

/**
 * The window a `not_found` rests on: no pass the read could have returned (live, in the actor's
 * templates and event) matches the input. A match outside that is not a change to the answer, so an
 * uncounted miss cannot say that such a pass exists.
 */
export function notFoundWindow(
  actor: ScanActor,
  match: CandidateMatchInput | null,
): ReturnType<typeof missWindow> {
  if (!match) return missWindow('{org} IS NOT NULL', []);
  const found = matchingPassSql(
    match,
    { org: '{org}', mode: '{mode}' },
    acceptedFilter(actor, true),
  );
  const none = absent(found);
  return missWindow(none.sql, none.params);
}

/**
 * Count a `not_found` and confirm it: no pass the read could have returned matches the input, the
 * actor and the credential's refs still hold. False when nothing was counted. Throws
 * `SCAN_TOO_MANY_MISSES` past the cap.
 */
export async function countNotFound(
  ctx: ServiceContext,
  actor: ScanActor,
  match: CandidateMatchInput | null,
  refs: readonly string[] | undefined,
): Promise<boolean> {
  if (!Array.isArray(refs)) return false;
  return (
    (await grantReadMiss(ctx, actor, { refs, unchanged: notFoundWindow(actor, match) })) ===
    'counted'
  );
}
