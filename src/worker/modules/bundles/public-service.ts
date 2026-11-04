import { NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordPassEvents } from '../events/record.ts';
import { isOrgActive } from '../orgs/active.ts';
import { getPass, type Pass } from '../passes/repo.ts';
import { isTokenShape, type PublicPageModel, pageModel } from '../public/service.ts';
import { bundleAssetPath } from './assets.ts';
import { packagePassObjects } from './package.ts';
import { type BundleRow, getBundleByToken, listAddablePasses, membersOf } from './repo.ts';

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
  const members = await membersOf(ctx.env.DB, [bundle.id]);
  const passes = await Promise.all(members.map((m) => getPass(ctx.env.DB, m.pass_id)));
  return Promise.all(
    passes
      .flatMap((pass) => (pass ? [pass] : []))
      .map(async (pass) => {
        const model = await pageModel(ctx, pass);
        const assets = Object.fromEntries(
          Object.entries(model.assets).map(([name, path]) => [
            name,
            bundleAssetPath(path, pass.downloadToken, bundle.token, pass.id),
          ]),
        );
        return { pass, model: { ...model, assets } };
      }),
  );
}

/** A pass of this bundle (any state); anything else reads as a dead link. */
export async function bundlePass(
  ctx: ServiceContext,
  bundle: BundleRow,
  passId: string,
): Promise<Pass> {
  const members = await membersOf(ctx.env.DB, [bundle.id]);
  const pass = members.some((m) => m.pass_id === passId) ? await getPass(ctx.env.DB, passId) : null;
  if (!pass) throw notFound();
  return pass;
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
  const rows = await listAddablePasses(ctx.env.DB, bundle.id);
  if (rows.length === 0) throw new NotFoundError('No passes to add.', 'BUNDLE_EMPTY');
  return {
    body: packagePassObjects(
      ctx.env.BUCKET,
      rows.map((r) => ({ id: r.id, objectKey: r.object_key, objectSize: r.object_size })),
    ),
    passIds: rows.map((r) => r.id),
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
