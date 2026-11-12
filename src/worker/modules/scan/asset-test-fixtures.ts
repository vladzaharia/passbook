import type { ScannerFixture } from '../../../../test/helpers/index.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { scannerActor, withRole } from './actor.ts';
import { mintAssetGrant } from './assets.ts';
import { getScanner } from './repo-device.ts';
import { candidateById } from './repo-lookup.ts';
import { readScannerScope } from './repo-scope.ts';
import { bindScanningSession } from './scanning-workspace.ts';
import { boundStaff } from './staff-binding.ts';
import { proofedScanActor, type ScanKit } from './test-kit.ts';
import { captureTestEpochs } from './test-kit-epochs.ts';

/** Construct the same scanner authority that the route guard reads. */
export async function assetActorFor(kit: ScanKit, scanner: ScannerFixture, now = kit.clock.now()) {
  const ctx = { ...kit.ctx, clock: { now: () => now } };
  await ensureCredentialRefKeyset(ctx.env.DB, ctx.env);
  const row = await getScanner(ctx.env.DB, scanner.id);
  if (!row) throw new Error('Scanner fixture is missing');
  const scope = await readScannerScope(ctx.env.DB, row, row.staffId);
  const actor = await proofedScanActor(
    ctx,
    scannerActor(ctx, row, row.mode, scanner.headers.authorization ? 'bearer' : 'cookie', scope),
    { epochs: false },
  );
  withRole(actor, actor.terminal ? null : await boundStaff(ctx, row, scope.staff));
  await bindScanningSession(ctx, actor);
  withRole(actor, actor.settings.staffSignIn ? actor.staff : null);
  // Like the route guard: epochs are captured once staff and session are bound.
  await captureTestEpochs(ctx, actor);
  return actor;
}

/** Mint for the current pass snapshot using the same guarded insert as production. */
async function grantForPurpose(
  kit: ScanKit,
  scanner: ScannerFixture,
  passId: string,
  now: number,
  requirePhoto: boolean,
): Promise<string> {
  const ctx = { ...kit.ctx, clock: { now: () => now } };
  const actor = await assetActorFor(kit, scanner, now);
  const candidate = await candidateById(ctx.env.DB, actor.orgId, passId);
  if (!candidate) throw new Error('Pass fixture is outside the scanner organization');
  return mintAssetGrant(
    ctx,
    actor,
    candidate,
    candidate.connectionGeneration,
    candidate.activeTemplateVersion,
    undefined,
    requirePhoto,
    'commit',
  );
}

/** Mint a generic, non-photo asset capability. */
export function genericAssetGrantFor(
  kit: ScanKit,
  scanner: ScannerFixture,
  passId: string,
  now = kit.clock.now(),
) {
  return grantForPurpose(kit, scanner, passId, now, false);
}

/** Mint a photo-only capability for an existing member photo. */
export function photoAssetGrantFor(
  kit: ScanKit,
  scanner: ScannerFixture,
  passId: string,
  now = kit.clock.now(),
) {
  return grantForPurpose(kit, scanner, passId, now, true);
}

/** Observe cancellation without consuming the R2 body before the handler does. */
export function observeCancellation(object: R2ObjectBody, onCancel: () => void): R2ObjectBody {
  const reader = object.body.getReader();
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const result = await reader.read();
        if (result.done) controller.close();
        else controller.enqueue(result.value);
      },
      async cancel(reason) {
        onCancel();
        await reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
  return new Proxy(object, {
    get(target, property) {
      if (property === 'body') return body;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
