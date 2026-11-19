import { unzipSync } from 'fflate';
import { packagePassBytes, signPass } from '../../../passkit/index.ts';
import { AppError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { holderChannels } from '../channels/gate.ts';
import { depsOf } from '../passes/deps.ts';
import type { PassFileVariant } from '../passes/file.ts';
import { applyRemoval } from '../passes/remove-build.ts';
import type { Pass } from '../passes/repo.ts';

const RESERVED = new Set(['pass.json', 'manifest.json', 'signature']);
const decoder = new TextDecoder();

/**
 * The Apple file a registered device gets now: the voided variant while Apple was turned off for
 * this pass or its template, else null (the live pass). An org or platform block never retires a
 * copy, so it keeps serving the live file.
 */
export async function appleVariant(
  ctx: ServiceContext,
  pass: Pass,
): Promise<PassFileVariant | null> {
  const { effective } = await holderChannels(ctx, pass);
  const apple = effective.apple;
  if (apple.on || (apple.source !== 'pass' && apple.source !== 'template')) return null;
  return voidedVariant(ctx, pass);
}

/**
 * The stored signed pass with `applyRemoval` applied and signed again, cached in R2 by (pass,
 * version, variant). A version bump (an Apple flip, N4) is what makes a device fetch it.
 */
export async function voidedVariant(ctx: ServiceContext, pass: Pass): Promise<PassFileVariant> {
  const variant = {
    objectKey: `passes/${pass.id}/v${pass.version}-voided.pkpass`,
    name: 'voided',
  };
  const bucket = ctx.env.BUCKET;
  if (await bucket.head(variant.objectKey)) return variant;
  const stored = await bucket.get(pass.objectKey);
  if (!stored) throw new NotFoundError('The pass file is missing.', 'PASS_FILE_MISSING');
  const files = unzipSync(new Uint8Array(await stored.arrayBuffer()));
  const raw = files['pass.json'];
  if (!raw) throw new AppError('PASS_FILE_INVALID', 500, 'The pass file is invalid.');
  const json = JSON.parse(decoder.decode(raw)) as Parameters<typeof applyRemoval>[0];
  applyRemoval(json, { message: null, at: pass.modifiedAt });
  const assets = Object.fromEntries(Object.entries(files).filter(([name]) => !RESERVED.has(name)));
  const identity = await depsOf(ctx.env).identities.byId(pass.identityId);
  const signed = await signPass(json as Record<string, unknown>, assets, identity.material, {
    now: new Date(ctx.clock.now()),
  });
  await bucket.put(variant.objectKey, packagePassBytes(signed), {
    httpMetadata: { contentType: 'application/vnd.apple.pkpass' },
  });
  return variant;
}
