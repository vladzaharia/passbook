import { unzipSync } from 'fflate';
import {
  sameTimedKeys,
  type TimedKeys,
  timedKeysOf,
  withTimedKeys,
} from '../../../passkit/behaviors/upcoming-events/timed.ts';
import { packagePassBytes, signPass } from '../../../passkit/index.ts';
import type { PassJson } from '../../../passkit/types.ts';
import { AppError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { assertNotPreviewOnly } from '../developer/fence.ts';
import type { Artifact } from './builder.ts';
import { depsOf } from './deps.ts';
import { type PassFileVariant, servePassFile } from './file.ts';
import { type CurrentRender, currentRenders } from './repo-boundaries.ts';
import type { Pass } from './repo-map.ts';

// The manifest and signature are made again; personalization.json stays while the artifact has it.
const RESERVED = new Set(['pass.json', 'manifest.json', 'signature']);
const decoder = new TextDecoder();
const second = (ms: number) => Math.floor(ms / 1000);

/** What a render needs of a pass: its current artifact and who signs it. */
export type TimedPass = Pick<Pass, 'id' | 'objectKey' | 'orgId' | 'identityId'>;

const live = (pass: Pick<Pass, 'status' | 'removedAt' | 'deletedAt'>) =>
  pass.status === 'active' && pass.removedAt === null && pass.deletedAt === null;

/**
 * The file a device or holder gets now (docs/design/event-boundaries.md): the live pass as its last event
 * boundary left it, as a variant that splices the render's timed keys into the stored package. A publish
 * in the second of the last render counts as a timestamp collision, so it never hides behind a 304.
 */
export async function currentFile(
  ctx: ServiceContext,
  pass: Pass,
): Promise<{ pass: Pass; variant: PassFileVariant | undefined }> {
  const row = (await currentRenders(ctx.env.DB, [pass])).get(pass.id);
  const collides = !!row && row.stampedAt > 0 && second(row.stampedAt) === second(pass.modifiedAt);
  const served = collides ? { ...pass, modifiedCollision: true } : pass;
  const keys = row?.render ?? null;
  if (!row || keys === null || !live(pass)) return { pass: served, variant: undefined };
  return {
    pass: served,
    variant: {
      objectKey: pass.objectKey,
      name: `t${row.renderedAt}`,
      modifiedAt: row.stampedAt,
      render: () => renderTimed(ctx, pass, JSON.parse(keys) as TimedKeys),
    },
  };
}

/** The pass file a holder downloads: the timed render when one is current. Callers gate the channel. */
export async function serveCurrentPassFile(
  ctx: ServiceContext,
  pass: Pass,
  request: Request,
): Promise<Response> {
  const current = await currentFile(ctx, pass);
  return servePassFile(ctx.env.BUCKET, current.pass, request, {}, current.variant);
}

/** The renders of several passes' current artifacts, read once (a `.pkpasses` or an attachment). */
export function passRenders(
  ctx: ServiceContext,
  passes: readonly Pick<Pass, 'id' | 'objectKey'>[],
): Promise<Map<string, CurrentRender>> {
  return currentRenders(ctx.env.DB, passes);
}

/**
 * The .pkpass bytes a holder gets now: the stored package with the current render's timed keys signed in,
 * or the stored bytes when no render applies. `render` from `passRenders` keeps a package's sizes true;
 * omitted, it is read here. Null when the stored object is missing.
 */
export async function currentPassBytes(
  ctx: ServiceContext,
  pass: TimedPass,
  render?: CurrentRender | null,
): Promise<Uint8Array | null> {
  const row = render === undefined ? (await passRenders(ctx, [pass])).get(pass.id) : render;
  if (row?.render) return renderTimed(ctx, pass, JSON.parse(row.render) as TimedKeys);
  const object = await ctx.env.BUCKET.get(pass.objectKey);
  return object ? new Uint8Array(await object.arrayBuffer()) : null;
}

/**
 * A fresh build that differs from the artifact only in its timed keys, which equal the current render's:
 * devices already have it, so a sync or a save that changes nothing makes no version and no push.
 */
export async function sameAsRender(
  ctx: ServiceContext,
  current: Pick<Pass, 'id' | 'objectKey' | 'contentHash'>,
  artifact: Pick<Artifact, 'passJson' | 'contentHashWith'>,
  previous: PassJson | null,
): Promise<boolean> {
  if (current.contentHash === null || previous === null) return false;
  // Only a pass that lists events has renders: every other publish skips the read.
  const events = 'upcomingPassInformation';
  if (!(events in previous) && !(events in artifact.passJson)) return false;
  const render = (await passRenders(ctx, [current])).get(current.id)?.render;
  if (!render || !sameTimedKeys(timedKeysOf(artifact.passJson), JSON.parse(render) as TimedKeys))
    return false;
  return (await artifact.contentHashWith(timedKeysOf(previous))) === current.contentHash;
}

/** Signed again on each fetch: a device fetches once per render, so nothing is stored. */
async function renderTimed(ctx: ServiceContext, pass: TimedPass, keys: TimedKeys) {
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
