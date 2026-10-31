import type { Logger } from '../../platform/log.ts';
import { ImageInvalid, type ImageTools } from './package/images.ts';

/** 9412: not an image. 9520: unsupported or corrupt input. */
const INVALID_IMAGE = new Set([9412, 9520]);
const NO_BACKEND = /not implemented|not supported|unsupported in local|no backend/i;

function stream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new Response(bytes as BufferSource).body as ReadableStream<Uint8Array>;
}

function errorCode(error: unknown): number | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? code : undefined;
}

/**
 * Images binding as ImageTools. Local dev and some test runtimes lack the backend: only a missing
 * binding or an explicit "not implemented" error makes it unavailable. Every other failure
 * (limits, timeouts, internal errors) is rethrown so the workflow step retries.
 */
export function imagesFromBinding(images: ImagesBinding | undefined, log: Logger): ImageTools {
  let available = images !== undefined;
  const handle = (op: string, error: unknown): null => {
    const code = errorCode(error);
    if (op === 'info' && code !== undefined && INVALID_IMAGE.has(code))
      throw new ImageInvalid('Not an image.');
    const message = error instanceof Error ? error.message : '';
    if (!NO_BACKEND.test(message)) {
      log.warn('templates.images_failed', { op, code });
      throw error;
    }
    available = false;
    log.warn('templates.images_unavailable', { op, code });
    return null;
  };
  return {
    async info(bytes) {
      if (!images || !available) return null;
      try {
        const result = await images.info(stream(bytes));
        return 'width' in result
          ? { width: result.width, height: result.height, format: result.format }
          : null;
      } catch (error) {
        return handle('info', error);
      }
    },
    async resize(bytes, width, height) {
      if (!images || !available) return null;
      try {
        const result = await images
          .input(stream(bytes))
          .transform({ width, height, fit: 'scale-down' })
          .output({ format: 'image/png' });
        return new Uint8Array(await new Response(result.image()).arrayBuffer());
      } catch (error) {
        return handle('resize', error);
      }
    },
  };
}
