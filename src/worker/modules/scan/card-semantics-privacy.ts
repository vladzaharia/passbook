import type { Json } from '../../../passkit/types.ts';
import { type CardPrivacy, cardPrivacy } from './dto-projection.ts';
import type { ScanActor } from './guard.ts';
import { scanPrivateName, scanValueSafe } from './projection-privacy.ts';
import type { Found } from './resolve.ts';

const PROTOTYPE_KEYS = { proto: true, constructor: true, prototype: true };
export const privateKey = (key: string) =>
  scanPrivateName(key) ||
  Object.hasOwn(PROTOTYPE_KEYS, key.replace(/[^a-z0-9]/gi, '').toLowerCase());

/** Known timestamps are not telephone numbers, but must still match no protected value. */
export function safeTimestamp(
  found: Found,
  actor: ScanActor,
  privacy: CardPrivacy,
  value: number,
): boolean {
  if (
    !Number.isSafeInteger(value) ||
    Math.abs(value) > 8_640_000_000_000_000 ||
    !scanValueSafe(found, value, actor)
  )
    return false;
  // An ISO-prefixed, letter-framed epoch avoids phone-number detection while the
  // canonical predicate still sees protected numeric spellings, defaults and Wallet values.
  return (
    privacy.safe(value) || (Math.abs(value) >= 1_000_000 && privacy.safe(`0000-01-01T${value}t`))
  );
}

/** Clean each leaf and key, not just top-level inputs: lookups and history can contain copies. */
export function safeJson(
  found: Found,
  actor: ScanActor,
  value: unknown,
  privacy: CardPrivacy = cardPrivacy(found, actor),
  timestamps = false,
): Json | undefined {
  const project = (part: unknown, key = ''): Json | undefined => {
    if (part === null) return null;
    if (
      typeof part === 'number' &&
      timestamps &&
      (key === 'at' || key === 'opensAt' || key === 'closesAt' || key === 'checkedInAt')
    )
      return safeTimestamp(found, actor, privacy, part) ? part : undefined;
    if (typeof part === 'string' || typeof part === 'number' || typeof part === 'boolean')
      return privacy.safe(part) ? part : undefined;
    if (Array.isArray(part)) return part.map((entry) => project(entry, key) ?? null);
    if (typeof part !== 'object') return undefined;
    const result: Record<string, Json> = {};
    for (const [key, entry] of Object.entries(part)) {
      if (privateKey(key) || !privacy.safe(key)) continue;
      const safe = project(entry, key);
      if (safe !== undefined) result[key] = safe;
    }
    return result;
  };
  return project(value);
}
