import { unzipSync } from 'fflate';
import { type TimedKeys, withTimedKeys } from '../../../passkit/behaviors/upcoming-events/timed.ts';
import { packagePassBytes, signPass } from '../../../passkit/index.ts';
import { AppError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { assertNotPreviewOnly } from '../developer/fence.ts';
import { depsOf } from './deps.ts';
import { type PassFileVariant, servePassFile } from './file.ts';
import { currentRender } from './repo-boundaries.ts';
import type { Pass } from './repo-map.ts';

// The manifest and signature are made again; personalization.json stays while the artifact has it.
const RESERVED = new Set(['pass.json', 'manifest.json', 'signature']);
const decoder = new TextDecoder();

/**
 * The live pass as its last event boundary left it (docs/design/event-boundaries.md): the stored
 * package with the timed keys of the render put in. Null when devices get the stored file as is.
 */
export async function timedVariant(
  ctx: ServiceContext,
  pass: Pass,
): Promise<PassFileVariant | null> {
  if (pass.status !== 'active' || pass.removedAt !== null || pass.deletedAt !== null) return null;
  const row = await currentRender(ctx.env.DB, { id: pass.id, objectKey: pass.objectKey });
  if (!row) return null;
  return {
    objectKey: pass.objectKey,
    name: `t${row.renderedAt}`,
    modifiedAt: row.stampedAt,
    render: () => renderTimed(ctx, pass, JSON.parse(row.render) as TimedKeys),
  };
}

/** The pass file a holder downloads: the timed render when one is current. Callers gate the channel. */
export async function serveCurrentPassFile(
  ctx: ServiceContext,
  pass: Pass,
  request: Request,
): Promise<Response> {
  return servePassFile(
    ctx.env.BUCKET,
    pass,
    request,
    {},
    (await timedVariant(ctx, pass)) ?? undefined,
  );
}

/** Signed again on each fetch: a device fetches once per render, so nothing is stored. */
async function renderTimed(ctx: ServiceContext, pass: Pass, keys: TimedKeys): Promise<Uint8Array> {
  await assertNotPreviewOnly(ctx.env.DB, pass.orgId);
  const stored = await ctx.env.BUCKET.get(pass.objectKey);
  if (!stored) throw new NotFoundError('The pass file is missing.', 'PASS_FILE_MISSING');
  const files = unzipSync(new Uint8Array(await stored.arrayBuffer()));
  const raw = files['pass.json'];
  if (!raw) throw new AppError('PASS_FILE_INVALID', 500, 'The pass file is invalid.');
  const json = withTimedKeys(JSON.parse(decoder.decode(raw)), keys);
  const assets = Object.fromEntries(Object.entries(files).filter(([name]) => !RESERVED.has(name)));
  const identity = await depsOf(ctx.env).identities.byId(pass.identityId);
  const signed = await signPass(json as Record<string, unknown>, assets, identity.material, {
    now: new Date(ctx.clock.now()),
  });
  return packagePassBytes(signed);
}
