import { expect } from 'vitest';

/** Asserts a short secret (PIN, code) is not stored; ignores digit runs inside ids and timestamps. */
export function expectSecretAbsent(haystack: unknown, secret: string): void {
  const text = typeof haystack === 'string' ? haystack : JSON.stringify(haystack);
  const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  expect(text ?? '').not.toMatch(new RegExp(`(?<![0-9A-Za-z-])${escaped}(?![0-9A-Za-z-])`));
}
