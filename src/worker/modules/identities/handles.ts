import { MANAGED_PREFIX } from '../../../shared/identity-handle.ts';

export { HANDLE_PATTERN, handleBase } from '../../../shared/identity-handle.ts';

/** Refused as a handle. Also seeded into `identity_handles` so the database refuses them too. */
export const RESERVED_HANDLES: ReadonlySet<string> = new Set([
  'wallet',
  'test',
  'demo',
  'platform',
  'passbook',
  'devtest',
  'apple',
  'google',
  'samsung',
  'admin',
  'api',
]);
const MAX_SUFFIX = 99;

export const passTypeOf = (handle: string): string => `${MANAGED_PREFIX}${handle}`;

/** `acme`, `acme2`, `acme3`, and so on, for a collision. */
export function* handleCandidates(base: string): Generator<string> {
  yield base;
  for (let n = 2; n <= MAX_SUFFIX; n++) yield `${base}${n}`;
}
