import { PackageLimitError, packagePasses } from '../../../passkit/index.ts';
import { MY_PASSES_BUNDLE_SIZE } from '../../../shared/contracts/me.ts';
import { ConflictError, NotFoundError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { type BundleRow, bundlePassIsCurrent, listBundleIds, listBundlePasses } from './repo.ts';

/** Each object is checked again after its R2 read, before the archive emits its bytes. */
function packageMyPasses(ctx: ServiceContext, userId: string, rows: readonly BundleRow[]) {
  try {
    return packagePasses(
      rows.map((row) => ({
        name: row.id,
        ...(row.object_size ? { size: row.object_size } : {}),
        bytes: async () => {
          const object = await ctx.env.BUCKET.get(row.object_key);
          if (!object) throw new NotFoundError('A pass file is missing.', 'PASS_FILE_MISSING');
          const bytes = new Uint8Array(await object.arrayBuffer());
          if (!(await bundlePassIsCurrent(ctx.env.DB, userId, row))) {
            throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
          }
          return bytes;
        },
      })),
    );
  } catch (error) {
    if (error instanceof PackageLimitError) {
      throw new ConflictError(
        'The bundle is too large. Add passes one by one.',
        'BUNDLE_TOO_LARGE',
      );
    }
    throw error;
  }
}

const TOKEN_ID = /^[A-Za-z0-9-]{1,64}$/;

/**
 * Add all, fixed at one moment: the token lists the first (newest) id of each part. A part is the
 * id range up to its first id and above the next part's, so passes added to Wallet in between
 * only leave their own part and no other pass moves into or out of a part.
 */
export async function bundleSnapshot(ctx: ServiceContext, userId: string) {
  const ids = await listBundleIds(ctx.env.DB, userId);
  const starts = ids.filter((_, index) => index % MY_PASSES_BUNDLE_SIZE === 0);
  if (ids.length === 0) return null;
  return { token: starts.join(','), count: ids.length, parts: starts.length };
}

function partsOf(token: string): string[] {
  const starts = token.split(',');
  if (starts.length > 1000 || !starts.every((id) => TOKEN_ID.test(id))) {
    throw new ValidationError('This Add all link is not valid.', [], 'BUNDLE_SNAPSHOT_INVALID');
  }
  return starts;
}

/** Signed .pkpass objects of my active passes, up to ten per part, from one snapshot. */
export async function myPassesBundle(
  ctx: ServiceContext,
  userId: string,
  part: number,
  snapshot?: string,
) {
  const token = snapshot ?? (await bundleSnapshot(ctx, userId))?.token ?? '';
  const starts = token ? partsOf(token) : [];
  const first = starts[part - 1];
  if (first === undefined) throw new NotFoundError('No passes to bundle.', 'BUNDLE_EMPTY');
  const rows = await listBundlePasses(
    ctx.env.DB,
    userId,
    { first, after: starts[part] ?? null },
    MY_PASSES_BUNDLE_SIZE,
  );
  if (rows.length === 0) throw new NotFoundError('No passes to bundle.', 'BUNDLE_EMPTY');
  return { body: packageMyPasses(ctx, userId, rows), parts: starts.length };
}
