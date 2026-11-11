const PHOTO_PATH = /^\/api\/v1\/scan\/[0-9A-Za-z_./-]+$/;
const PHOTO_PARAMS = new Set(['g', 'orgId', 'timeZone', 'setupId', 'eventId', 'templateIds']);
const GRANT = /^[0-9A-Za-z_-]+$/;

/**
 * True for a photo URL our own code built: a relative scan path and known query keys with a plain
 * grant token. Judged by structure, not by the privacy filter: ids and zones in the query can read
 * as phone numbers, while anything not shaped like ours is dropped.
 */
export function isOwnPhotoUrl(value: string): boolean {
  const cut = value.indexOf('?');
  const path = cut < 0 ? value : value.slice(0, cut);
  if (!PHOTO_PATH.test(path) || path.includes('..')) return false;
  if (cut < 0) return true;
  const params = new URLSearchParams(value.slice(cut + 1));
  let grant = false;
  for (const [name, entry] of params) {
    if (!PHOTO_PARAMS.has(name) || entry === '') return false;
    if (name === 'g') {
      if (!GRANT.test(entry)) return false;
      grant = true;
    }
  }
  return grant;
}
