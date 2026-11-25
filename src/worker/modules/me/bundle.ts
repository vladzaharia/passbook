import { PackageLimitError, packagePasses } from '../../../passkit/index.ts';
import { MY_PASSES_BUNDLE_SIZE } from '../../../shared/contracts/me.ts';
import { ConflictError, NotFoundError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { holderChannelsMany, recordCopy } from '../channels/gate.ts';
import { assertSignedObject } from '../developer/fence.ts';
import { currentPassBytes, passRenders } from '../passes/timed-variant.ts';
import {
  type BundleRow,
  bundlePassIsCurrent,
  listBundleCandidates,
  listBundlePasses,
} from './repo-bundle.ts';

/**
 * Each object is checked again after its R2 read, before the archive emits its bytes. A pass with a timed
 * render goes as the render (docs/design/event-boundaries.md), so its size is not known up front.
 */
async function packageMyPasses(ctx: ServiceContext, userId: string, rows: readonly BundleRow[]) {
  for (const row of rows) assertSignedObject(row.object_key);
  const renders = await passRenders(
    ctx,
    rows.map((row) => ({ id: row.id, objectKey: row.object_key })),
  );
  try {
    return packagePasses(
      rows.map((row) => {
        const render = renders.get(row.id) ?? null;
        return {
          name: row.id,
          ...(row.object_size && !render?.render ? { size: row.object_size } : {}),
          bytes: async () => {
            const pass = {
              id: row.id,
              objectKey: row.object_key,
              orgId: row.org_id,
              identityId: row.identity_id,
            };
            const bytes = await currentPassBytes(ctx, pass, render);
            if (!bytes) throw new NotFoundError('A pass file is missing.', 'PASS_FILE_MISSING');
            if (!(await bundlePassIsCurrent(ctx.env.DB, userId, ctx.clock.now(), row))) {
              throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
            }
            return bytes;
          },
        };
      }),
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

const toGate = (
  p: Pick<BundleRow, 'id' | 'org_id' | 'mode' | 'template_id' | 'template_version'>,
) => ({
  id: p.id,
  orgId: p.org_id,
  mode: p.mode,
  templateId: p.template_id,
  templateVersion: p.template_version,
});

/** Only passes whose Apple channel is on are bundled; the gate is the same as the single download. */
async function appleOn<
  T extends Pick<BundleRow, 'id' | 'org_id' | 'mode' | 'template_id' | 'template_version'>,
>(ctx: ServiceContext, rows: readonly T[]): Promise<T[]> {
  const many = await holderChannelsMany(ctx, rows.map(toGate));
  return rows.filter((p) => many.get(p.id)?.effective.apple.on);
}

const appleIds = async (
  ctx: ServiceContext,
  rows: Parameters<typeof appleOn>[1],
): Promise<string[]> => (await appleOn(ctx, rows)).map((p) => p.id);

const TOKEN_ID = /^[A-Za-z0-9-]{1,64}$/;

/**
 * Add all, fixed at one moment: the token lists the first (newest) id of each part. A part is the
 * id range up to its first id and above the next part's, so passes added to Wallet in between
 * only leave their own part and no other pass moves into or out of a part.
 */
export async function bundleSnapshot(ctx: ServiceContext, userId: string) {
  const ids = await appleIds(ctx, await listBundleCandidates(ctx.env.DB, userId, ctx.clock.now()));
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
  const rows = await appleOn(
    ctx,
    await listBundlePasses(
      ctx.env.DB,
      userId,
      ctx.clock.now(),
      { first, after: starts[part] ?? null },
      MY_PASSES_BUNDLE_SIZE,
    ),
  );
  if (rows.length === 0) throw new NotFoundError('No passes to bundle.', 'BUNDLE_EMPTY');
  for (const row of rows) await recordCopy(ctx, toGate(row), 'apple');
  return { body: await packageMyPasses(ctx, userId, rows), parts: starts.length };
}
