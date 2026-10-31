import { bodyLimit } from 'hono/body-limit';
import { PayloadTooLargeError } from '../../platform/errors.ts';

/** Counts streamed bytes too, so a missing Content-Length does not bypass the cap. */
export const limitBody = (maxSize: number) =>
  bodyLimit({
    maxSize,
    onError: () => {
      throw new PayloadTooLargeError();
    },
  });
