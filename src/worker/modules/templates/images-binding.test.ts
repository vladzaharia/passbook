import { describe, expect, it } from 'vitest';
import { createLogger } from '../../platform/log.ts';
import { imagesFromBinding } from './images-binding.ts';
import { ImageInvalid } from './package/images.ts';

const log = createLogger({});
const bytes = new Uint8Array([1, 2, 3]);

function failing(error: unknown): ImagesBinding {
  return {
    info: async () => {
      throw error;
    },
    input: () => {
      throw error;
    },
  } as unknown as ImagesBinding;
}

describe('imagesFromBinding', () => {
  it('is unavailable without a binding', async () => {
    expect(await imagesFromBinding(undefined, log).info?.(bytes)).toBeNull();
  });

  it('is unavailable when the local backend is not implemented', async () => {
    const tools = imagesFromBinding(failing(new Error('Not implemented in local mode')), log);
    expect(await tools.info?.(bytes)).toBeNull();
    expect(await tools.resize?.(bytes, 1, 1)).toBeNull();
  });

  it('maps 9412 and 9520 to ImageInvalid', async () => {
    for (const code of [9412, 9520])
      await expect(
        imagesFromBinding(failing(Object.assign(new Error('bad'), { code })), log).info?.(bytes),
      ).rejects.toBeInstanceOf(ImageInvalid);
  });

  it('rethrows transient failures so the step retries', async () => {
    const limit = Object.assign(new Error('usage limit'), { code: 9422 });
    const tools = imagesFromBinding(failing(limit), log);
    await expect(tools.info?.(bytes)).rejects.toBe(limit);
    await expect(tools.resize?.(bytes, 1, 1)).rejects.toBe(limit);
  });
});
