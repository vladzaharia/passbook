export const MANAGED_PREFIX = 'pass.mobile.passbook.';
export const HANDLE_PATTERN = /^[a-z][a-z0-9]{1,29}$/;
/** Refused as a handle. Also seeded into `identity_handles` so the database refuses them too. */
export const RESERVED_HANDLES: ReadonlySet<string> = new Set([
  'wallet',
  'test',
  'demo',
  'platform',
  'passbook',
  'apple',
  'google',
  'samsung',
  'admin',
  'api',
]);
/** Room for a numeric suffix inside the 30 character limit. */
const BASE_MAX = 27;
const MAX_SUFFIX = 99;

export const passTypeOf = (handle: string): string => `${MANAGED_PREFIX}${handle}`;

/** The default handle of an org slug: lowercase letters and digits only, starting with a letter. */
export function handleBase(slug: string): string {
  let base = slug.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!/^[a-z]/.test(base)) base = `org${base}`;
  base = base.slice(0, BASE_MAX);
  return base.length < 2 ? `${base}org` : base;
}

/** `acme`, `acme2`, `acme3`, and so on, for a collision. */
export function* handleCandidates(base: string): Generator<string> {
  yield base;
  for (let n = 2; n <= MAX_SUFFIX; n++) yield `${base}${n}`;
}
