import { fromBase64Url, safeEqualBytes, toBase64Url } from '../../platform/ids.ts';

/** Compare canonical, full-length CSRF proofs without leaking their bytes. */
export function sameCsrfProof(actual: string, expected: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(actual) || !/^[A-Za-z0-9_-]{43}$/.test(expected)) return false;
  const a = fromBase64Url(actual);
  const b = fromBase64Url(expected);
  return toBase64Url(a) === actual && toBase64Url(b) === expected && safeEqualBytes(a, b);
}
