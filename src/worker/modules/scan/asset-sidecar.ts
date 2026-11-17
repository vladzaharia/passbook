import type { ScanActor } from './actor.ts';
import type { PreparedAssetGrant } from './asset-types.ts';

/** The capability and its recipient stay out of any cloneable plan. */
interface AssetGrantSidecar {
  token: string;
  actor: ScanActor;
}

const sidecars = new WeakMap<PreparedAssetGrant, AssetGrantSidecar>();

export function holdAssetGrantSidecar(plan: PreparedAssetGrant, sidecar: AssetGrantSidecar): void {
  sidecars.set(plan, sidecar);
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

/** The token of a photo grant, only for the recipient and pass it was minted for. */
export function takePhotoGrantToken(
  actor: ScanActor,
  passId: string,
  plan: PreparedAssetGrant,
): string | null {
  const sidecar = sidecars.get(plan);
  const expected = sidecar?.actor;
  if (
    !sidecar ||
    !expected ||
    // The photo plan's purpose follows its release state (`photoGrantPurpose`, checked at mint).
    !plan.requirePhoto ||
    plan.passId !== passId ||
    actor.orgId !== plan.orgId ||
    actor.mode !== plan.mode ||
    !sameSnapshotValue(actor, expected, 'scanner') ||
    !sameSnapshotValue(actor.scanner, expected.scanner, 'csrfSecret')
  )
    return null;
  return sidecar.token;
}

export function takeAssetGrantToken(plan: PreparedAssetGrant): string | null {
  return sidecars.get(plan)?.token ?? null;
}
