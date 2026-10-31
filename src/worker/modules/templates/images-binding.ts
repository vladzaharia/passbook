import type { Logger } from '../../platform/log.ts';
import { ImageInvalid, type ImageTools } from './package/images.ts';

const NOT_AN_IMAGE = 9412;

function stream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new Response(bytes as BufferSource).body as ReadableStream<Uint8Array>;
}

function errorCode(error: unknown): number | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? code : undefined;
}

/**
 * Images binding as ImageTools. Local dev and some test runtimes lack the backend: after the first
 * non-image failure the backend is treated as unavailable and PNG structure checks stand alone.
 */
export function imagesFromBinding(images: ImagesBinding | undefined, log: Logger): ImageTools {
  let available = images !== undefined;
  const unavailable = (op: string, error: unknown) => {
    available = false;
    log.warn('templates.images_unavailable', { op, code: errorCode(error) });
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
        if (errorCode(error) === NOT_AN_IMAGE) throw new ImageInvalid('Not an image.');
        unavailable('info', error);
        return null;
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
        unavailable('resize', error);
        return null;
      }
    },
  };
}
