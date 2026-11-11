import type { ScanActor } from './actor.ts';
import { type AssetGrantBatchResult, grantInsertConfirmed } from './asset-grant-results.ts';
import type { AssetGrantSource, AssetSessionSnapshot, PreparedAssetGrant } from './asset-types.ts';

/** Request-local capability and actor credentials are never part of a cloneable plan. */
interface AssetGrantSidecar {
  token: string;
  tokenHash: string;
  actor: ScanActor;
  source: AssetGrantSource | undefined;
  recipientSession: AssetSessionSnapshot | null;
  sourceSession: AssetSessionSnapshot | null;
}

const sidecars = new WeakMap<PreparedAssetGrant, AssetGrantSidecar>();

export function holdAssetGrantSidecar(
  plan: PreparedAssetGrant,
  sidecar: Omit<AssetGrantSidecar, 'tokenHash'>,
): void {
  sidecars.set(plan, { ...sidecar, tokenHash: plan.tokenHash });
}

/** Materialize only actor authority; the capability remains in the private sidecar. */
export function assetGrantAuthority(
  plan: PreparedAssetGrant,
): Pick<AssetGrantSidecar, 'actor' | 'source' | 'recipientSession' | 'sourceSession'> | undefined {
  const sidecar = sidecars.get(plan);
  return sidecar && sidecar.tokenHash === plan.tokenHash
    ? {
        actor: sidecar.actor,
        source: sidecar.source,
        recipientSession: sidecar.recipientSession,
        sourceSession: sidecar.sourceSession,
      }
    : undefined;
}

/** Compare captured authority without cloning or serializing credentials. */
function sameSnapshotValue(actual: unknown, expected: unknown, ignore?: string): boolean {
  if (Object.is(actual, expected)) return true;
  if (!actual || !expected || typeof actual !== 'object' || typeof expected !== 'object')
    return false;
  if (Array.isArray(actual) || Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      Array.isArray(expected) &&
      actual.length === expected.length &&
      actual.every((value, index) => sameSnapshotValue(value, expected[index]))
    );
  const left = actual as Record<string, unknown>;
  const right = expected as Record<string, unknown>;
  for (const [key, value] of Object.entries(left)) {
    if (key !== ignore && !sameSnapshotValue(value, right[key])) return false;
  }
  return Object.entries(right).every(
    ([key, value]) => key === ignore || Object.hasOwn(left, key) || value === undefined,
  );
}

/** Check that URL scope still names the exact recipient and pass used at preparation. */
export function takePhotoGrantToken(
  actor: ScanActor,
  passId: string,
  plan: PreparedAssetGrant,
  results: readonly AssetGrantBatchResult[] | undefined,
): string | null {
  const expected = assetGrantAuthority(plan)?.actor;
  if (
    !expected ||
    !plan.guard.requirePhoto ||
    plan.guard.purpose !== 'commit' ||
    plan.guard.passId !== passId ||
    actor.orgId !== plan.orgId ||
    actor.mode !== plan.mode ||
    !sameSnapshotValue(actor, expected, 'scanner') ||
    !sameSnapshotValue(actor.scanner, expected.scanner, 'csrfSecret')
  )
    return null;
  return takeAssetGrantToken(plan, results);
}

/** Release the token only for this exact, fully confirmed INSERT and assertion slice. */
export function takeAssetGrantToken(
  plan: PreparedAssetGrant,
  results: readonly AssetGrantBatchResult[] | undefined,
): string | null {
  const sidecar = sidecars.get(plan);
  const inserted = results?.[0]?.results?.[0];
  if (
    !sidecar ||
    plan.tokenHash !== sidecar.tokenHash ||
    !grantInsertConfirmed(results) ||
    !inserted ||
    typeof inserted !== 'object' ||
    !('token_hash' in inserted) ||
    inserted.token_hash !== sidecar.tokenHash
  )
    return null;
  sidecars.delete(plan);
  return sidecar.token;
}
