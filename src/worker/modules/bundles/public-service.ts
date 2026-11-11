import { NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
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
  const bundle = await getBundleByToken(ctx.env.DB, token);
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
  const binding = await bindBundle(snapshot, '');
  const members = await Promise.all(
    snapshot.passes.map(async (pass) => {
      const model = await pageModel(ctx, pass);
      const assets = Object.fromEntries(
        Object.entries(model.assets).flatMap(([name, path]) => {
          const own = bundleAssetPath(path, pass.downloadToken, bundle.token, pass.id);
          return own === null ? [] : [[name, own]];
        }),
      );
      return { pass, model: { ...model, assets } };
    }),
  );
  const current = await bundleEmailSnapshot(ctx.env.DB, bundle.id);
  if (!current || !(await matchesBundle(current, binding))) throw notFound();
  await assertBundleMembers(
    ctx,
    bundle,
    members.map((member) => member.pass),
  );
  return members;
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

/** A lazy object read may cross a transfer; never emit a chunk without a fresh fence. */
export function fenceBundleStream(
  ctx: ServiceContext,
  bundle: BundleRow,
  passes: readonly Pass[],
  source: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          await assertBundleMembers(ctx, bundle, passes);
          const chunk = await reader.read();
          await assertBundleMembers(ctx, bundle, passes);
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
  const snapshot = await bundleEmailSnapshot(ctx.env.DB, bundle.id);
  const passes =
    snapshot && snapshot.bundle.token === bundle.token
      ? snapshot.passes.filter((pass) => pass.status === 'active' && pass.removedAt === null)
      : [];
  if (passes.length === 0) throw new NotFoundError('No passes to add.', 'BUNDLE_EMPTY');
  await assertBundleMembers(ctx, bundle, passes);
  const body = packagePassObjects(
    ctx.env.BUCKET,
    passes.map((pass) => ({ id: pass.id, objectKey: pass.objectKey, objectSize: pass.objectSize })),
  );
  return {
    body: fenceBundleStream(ctx, bundle, passes, body),
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
