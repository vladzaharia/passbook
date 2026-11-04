import { PackageLimitError, packagePasses } from '../../../passkit/index.ts';
import { ConflictError, NotFoundError } from '../../platform/errors.ts';

export interface PackablePass {
  id: string;
  objectKey: string;
  objectSize: number | null;
}

/**
 * A `.pkpasses` stream of signed pass objects (at most 10), as the portal's Add all and the
 * bundle link serve it. Object bytes are read lazily as the archive streams.
 */
export function packagePassObjects(bucket: R2Bucket, passes: readonly PackablePass[]) {
  try {
    return packagePasses(
      passes.map((pass) => ({
        name: pass.id,
        ...(pass.objectSize ? { size: pass.objectSize } : {}),
        bytes: async () => {
          const object = await bucket.get(pass.objectKey);
          if (!object) throw new NotFoundError('A pass file is missing.', 'PASS_FILE_MISSING');
          return new Uint8Array(await object.arrayBuffer());
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
