import { PackageLimitError, packagePasses } from '../../../passkit/index.ts';
import { ConflictError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { assertSignedObject } from '../developer/fence.ts';
import { currentPassBytes, passRenders, type TimedPass } from './timed-variant.ts';

export interface PackablePass extends TimedPass {
  objectSize: number | null;
}

/**
 * A `.pkpasses` stream of signed pass objects (at most 10), as the bundle link serves it. Object bytes are
 * read lazily as the archive streams; a pass with a timed render goes as the render, with no size up front.
 */
export async function packagePassObjects(ctx: ServiceContext, passes: readonly PackablePass[]) {
  for (const pass of passes) assertSignedObject(pass.objectKey);
  const renders = await passRenders(ctx, passes);
  try {
    return packagePasses(
      passes.map((pass) => {
        const render = renders.get(pass.id) ?? null;
        return {
          name: pass.id,
          ...(pass.objectSize && !render?.render ? { size: pass.objectSize } : {}),
          bytes: async () => {
            const bytes = await currentPassBytes(ctx, pass, render);
            if (!bytes) throw new NotFoundError('A pass file is missing.', 'PASS_FILE_MISSING');
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
