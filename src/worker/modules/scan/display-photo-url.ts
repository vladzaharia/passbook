const SCAN_PATH = /^\/api\/v1\/scan\/[0-9A-Za-z_./-]+(?:\?[0-9A-Za-z_.~%=&-]+)?$/;

/**
 * A photo URL the server built for this scan: a relative scan path with a plain query. The caller
 * supplies it only after its grant insert, so what its ids look like decides nothing; this is
 * the shape guard against a foreign, absolute or markup-carrying URL.
 */
export const isOwnPhotoUrl = (value: string): boolean =>
  SCAN_PATH.test(value) && !value.includes('..');
