import { revealToken } from '../../platform/capability-token.ts';
import { NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { channelOn } from '../channels/gate.ts';
import { assertNotPreviewOnly } from '../developer/fence.ts';
import { recordPassEvents } from '../events/record.ts';
import { isOrgActive } from '../orgs/active.ts';
import { packagePassObjects } from '../passes/package-objects.ts';
import type { Pass } from '../passes/repo.ts';
import { isTokenShape, type PublicPageModel, pageModel } from '../public/service.ts';
import { bundleAssetPath } from './assets.ts';
import { bindBundle, bundleEmailSnapshot, matchesBundle } from './email-binding.ts';
import { type BundleRow, getBundleByToken } from './repo.ts';
import { currentBundleMembers } from './repo-public.ts';

const notFound = () => new NotFoundError('This link is not valid.', 'LINK_NOT_FOUND');

/** Bearer-link lookup. A rotated or deleted bundle's token no longer resolves. */
export async function bundleForToken(ctx: ServiceContext, token: string): Promise<BundleRow> {
  if (!isTokenShape(token)) throw notFound();
  const bundle = await getBundleByToken(ctx.env, token);
  if (!bundle || !(await isOrgActive(ctx, bundle.org_id))) throw notFound();
  return bundle;
}

export interface BundleMember {
  pass: Pass;
  model: PublicPageModel;
}

/** The bundle's passes in order, with their page models and images under the bundle's own paths. */
export async function bundleMembers(
  ctx: ServiceContext,
  bundle: BundleRow,
): Promise<BundleMember[]> {
  const snapshot = await bundleEmailSnapshot(ctx.env.DB, bundle.id);
  if (!snapshot) {
    await assertBundleMembers(ctx, bundle, []);
    return [];
  }
  if (snapshot.bundle.token !== bundle.token) throw notFound();
  const binding = await bindBundle(ctx.env, snapshot, '');
  const bundleToken = await revealToken(ctx.env, 'bundle', bundle.id, bundle.org_id, bundle.token);
  const members = await Promise.all(
    snapshot.passes.map((pass) => bundleMember(ctx, bundleToken, pass)),
  );
  const current = await bundleEmailSnapshot(ctx.env.DB, bundle.id);
  if (!current || !(await matchesBundle(ctx.env, current, binding))) throw notFound();
  await assertBundleMembers(
    ctx,
    bundle,
    members.map((member) => member.pass),
  );
  return members;
}

/** A member's page model, its images under the bundle's own paths: no pass link in anything it holds. */
export async function bundleMember(
  ctx: ServiceContext,
  bundleToken: string,
  pass: Pass,
): Promise<BundleMember> {
  const model = await pageModel(ctx, pass);
  const passToken = await revealToken(ctx.env, 'pass', pass.id, pass.orgId, pass.downloadToken);
  const assets = Object.fromEntries(
    Object.entries(model.assets).flatMap(([name, path]) => {
      const own = bundleAssetPath(path, passToken, bundleToken, pass.id);
      return own === null ? [] : [[name, own]];
    }),
  );
  return { pass, model: { ...model, assets } };
}

/** A pass of this bundle (any state); anything else reads as a dead link. */
export async function bundlePass(
  ctx: ServiceContext,
  bundle: BundleRow,
  passId: string,
): Promise<Pass> {
  const snapshot = await bundleEmailSnapshot(ctx.env.DB, bundle.id);
  const pass = snapshot?.passes.find((member) => member.id === passId);
  if (!snapshot || snapshot.bundle.token !== bundle.token || !pass) throw notFound();
  await assertBundleMember(ctx, bundle, pass);
  return pass;
}

/** Recheck after reading a mutable asset and before handing its bytes to the caller. */
export async function assertBundleMember(
  ctx: ServiceContext,
  bundle: BundleRow,
  pass: Pass,
): Promise<void> {
  await assertBundleMembers(ctx, bundle, [pass]);
}

/** Recheck all disclosed members in the same D1 snapshot. */
export async function assertBundleMembers(
  ctx: ServiceContext,
  bundle: BundleRow,
  passes: readonly Pass[],
): Promise<void> {
  if (!(await currentBundleMembers(ctx.env.DB, bundle, passes))) throw notFound();
}

/**
 * A lazy object read may cross a transfer, so no chunk is emitted before a fence that follows
 * its read. A single file is one already-opened object: it is fenced before and after its first
 * chunk, then streams on (every later byte belongs to the object opened before any transfer). An
 * archive opens each member's object lazily, so every chunk is fenced; that is decided by
 * `archive`, not by how many members it holds.
 */
export function fenceBundleStream(
  ctx: ServiceContext,
  bundle: BundleRow,
  passes: readonly Pass[],
  source: ReadableStream<Uint8Array>,
  archive: boolean,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  const everyChunk = archive;
  let fenced = false;
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const check = everyChunk || !fenced;
          if (!fenced) await assertBundleMembers(ctx, bundle, passes);
          const chunk = await reader.read();
          if (check) await assertBundleMembers(ctx, bundle, passes);
          fenced = true;
          if (chunk.done) controller.close();
          else controller.enqueue(chunk.value);
        } catch (error) {
          await reader.cancel(error).catch(() => undefined);
          throw error;
        }
      },
      cancel: (reason) => reader.cancel(reason),
    },
    { highWaterMark: 0 },
  );
}

/** A pass that can be added: not voided, not removed. */
export async function addablePass(
  ctx: ServiceContext,
  bundle: BundleRow,
  passId: string,
): Promise<Pass> {
  const pass = await bundlePass(ctx, bundle, passId);
  if (pass.status !== 'active' || pass.removedAt !== null) throw notFound();
  return pass;
}

/** The `.pkpasses` body of the bundle's addable passes; voided and removed ones are left out. */
export async function bundleArchive(ctx: ServiceContext, bundle: BundleRow) {
  await assertNotPreviewOnly(ctx.env.DB, bundle.org_id);
  const snapshot = await bundleEmailSnapshot(ctx.env.DB, bundle.id);
  const live =
    snapshot && snapshot.bundle.token === bundle.token
      ? snapshot.passes.filter((pass) => pass.status === 'active' && pass.removedAt === null)
      : [];
  const apple = await Promise.all(live.map((pass) => channelOn(ctx, pass, 'apple')));
  const passes = live.filter((_, i) => apple[i]);
  if (passes.length === 0) throw new NotFoundError('No passes to add.', 'BUNDLE_EMPTY');
  await assertBundleMembers(ctx, bundle, passes);
  const body = await packagePassObjects(ctx, passes);
  return {
    body: fenceBundleStream(ctx, bundle, passes, body, true),
    passIds: passes.map((pass) => pass.id),
    passes,
  };
}

/** One ledger event per pass: the bundle's ids, never the token. */
export async function recordBundleEvents(
  ctx: ServiceContext,
  bundle: BundleRow,
  kind: 'bundle.opened' | 'bundle.downloaded',
  passIds: string[],
): Promise<void> {
  await recordPassEvents(
    ctx,
    passIds.map((passId) => ({
      orgId: bundle.org_id,
      passId,
      mode: bundle.mode,
      kind,
      data: { bundleId: bundle.id },
    })),
  );
}
