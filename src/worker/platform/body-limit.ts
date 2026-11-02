import type { MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { PayloadTooLargeError } from './errors.ts';

/** Counts streamed bytes too, so a missing Content-Length does not bypass the cap. */
export const limitBody = (maxSize: number) =>
  bodyLimit({
    maxSize,
    onError: () => {
      throw new PayloadTooLargeError();
    },
  });

export const DEFAULT_BODY_BYTES = 256 * 1024;

/** The default cap for a router, except where `except` matches the request path (own cap there). */
export const defaultBodyLimit = (except?: RegExp): MiddlewareHandler => {
  const sized = limitBody(DEFAULT_BODY_BYTES);
  return (c, next) => (except?.test(new URL(c.req.url).pathname) ? next() : sized(c, next));
};
