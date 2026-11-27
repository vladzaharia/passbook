import {
  applyDevicePassOverrides,
  type DevicePassOverrides,
  devicePassViolations,
} from '../../../passkit/device-pass.ts';
import { packagePassBytes, signPass } from '../../../passkit/index.ts';
import { baseUrl } from '../../platform/env.ts';
import { AppError, NotFoundError } from '../../platform/errors.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { ResolvedIdentity } from '../identities/env-identity.ts';
import { parseStoredPassJson } from '../passes/detail.ts';
import { applyRemoval } from '../passes/remove-build.ts';
import type { Pass } from '../passes/repo.ts';
import { passJsonAtVersion } from '../public/repo.ts';
import { openPublicAsset, passImages } from '../public/service.ts';
import { devicePassSerial, devicePassToken } from './device-pass-token.ts';
import type { DevicePassRow } from './repo-device-pass.ts';

const PASS_ASSET = /^[A-Za-z0-9_@.-]{1,100}\.png$/;

/** The pass's images as the pass page reads them: its overrides, the org's brand, then the template's. */
async function imagesOf(ctx: ServiceContext, source: Pass): Promise<Record<string, Uint8Array>> {
  const entries = await Promise.all(
    (await passImages(ctx, source))
      .filter((image) => PASS_ASSET.test(image.name))
      .map(async (image) => {
        const asset = await openPublicAsset(ctx, source, image.name);
        return [image.name, new Uint8Array(await new Response(asset.body).arrayBuffer())] as const;
      }),
  );
  return Object.fromEntries(entries);
}

/**
 * The device pass for `row`, from the source pass's current pass.json and images: signed under the device-test
 * identity (the same `signPass` and its `assertCanSign` as every pass), with the fixed overrides, checked before
 * signing. A sandbox pass is stored as its JSON, never a package, so this builds the package from the JSON the
 * Test preview page reads. An ended pass is the voided last copy, so a phone that still holds it stops showing a
 * live pass.
 */
export async function buildDevicePass(
  ctx: ServiceContext,
  row: DevicePassRow,
  source: Pass,
  identity: ResolvedIdentity,
): Promise<{ bytes: Uint8Array; hash: string }> {
  const raw = await passJsonAtVersion(ctx.env.DB, source.id, source.version);
  if (!raw) throw new NotFoundError('The pass has no stored version.', 'PASS_VERSION_MISSING');
  const ended = row.state === 'voided' || row.state === 'expired';
  const overrides: DevicePassOverrides = {
    passTypeIdentifier: identity.passTypeIdentifier,
    teamIdentifier: identity.teamIdentifier,
    serialNumber: devicePassSerial(row.id),
    authenticationToken: await devicePassToken(ctx.env, row.id, row.auth_nonce),
    webServiceURL: `${baseUrl(ctx.env)}/wallet`,
    expirationDate: ended ? (row.voided_at ?? ctx.clock.now()) : row.expires_at,
  };
  const json = applyDevicePassOverrides(parseStoredPassJson(raw), overrides);
  if (ended) applyRemoval(json, { message: null, at: overrides.expirationDate });
  const broken = devicePassViolations(json, overrides);
  if (broken.length > 0) {
    ctx.log.error('device_pass.build_invalid', { code: 'DEVICE_PASS_BUILD_INVALID', broken });
    throw new AppError('DEVICE_PASS_BUILD_INVALID', 500, 'The device pass could not be built.');
  }
  const signed = await signPass(
    json as Record<string, unknown>,
    await imagesOf(ctx, source),
    identity.material,
    {
      now: new Date(ctx.clock.now()),
    },
  );
  return { bytes: packagePassBytes(signed), hash: await sha256Hex(JSON.stringify(json)) };
}
