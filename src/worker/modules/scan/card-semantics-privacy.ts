import { isPrivateName } from '../../../passkit/template/scan-display/privacy.ts';
import type { Json } from '../../../passkit/types.ts';
import { type CardPrivacy, cardPrivacy } from './dto-projection.ts';
import type { ScanActor } from './guard.ts';
import type { Found } from './resolve.ts';

/** A timestamp is checked like any number: it must not be a secret's spelling. */
export function safeTimestamp(privacy: CardPrivacy, value: number): boolean {
  return (
    Number.isSafeInteger(value) && Math.abs(value) <= 8_640_000_000_000_000 && privacy.safe(value)
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
      return safeTimestamp(privacy, part) ? part : undefined;
    if (typeof part === 'string' || typeof part === 'number' || typeof part === 'boolean')
      return privacy.safe(part) ? part : undefined;
    if (Array.isArray(part)) return part.map((entry) => project(entry, key) ?? null);
    if (typeof part !== 'object') return undefined;
    const result: Record<string, Json> = {};
    for (const [key, entry] of Object.entries(part)) {
      if (isPrivateName(key) || !privacy.safe(key)) continue;
      const safe = project(entry, key);
      if (safe !== undefined) result[key] = safe;
    }
    return result;
  };
  return project(value);
}
