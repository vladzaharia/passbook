import type { Json, PassJson } from '../../types.ts';
import { PASS_STYLES } from '../../types.ts';

const FORMAT_KEYS = [
  'dateStyle',
  'timeStyle',
  'isRelative',
  'ignoresTimeZone',
  'numberStyle',
  'currencyCode',
] as const;

/**
 * How the pass shows each field that has formatting keys (dates, money, numbers). The scope keeps
 * the raw `fields` for conditions; a binding that reads one field shows it through this spec.
 */
export function passFieldFormats(
  passJson: PassJson | undefined,
  only?: Iterable<string>,
): Record<string, Json> {
  const keep = only ? new Set(only) : null;
  const out: Record<string, Json> = {};
  if (!passJson) return out;
  for (const style of PASS_STYLES) {
    const block = (passJson as Record<string, unknown>)[style];
    if (!block || typeof block !== 'object') continue;
    for (const group of Object.values(block as Record<string, unknown>)) {
      if (!Array.isArray(group)) continue;
      for (const field of group as Record<string, unknown>[]) {
        const key = field?.key;
        if (typeof key !== 'string' || (keep && !keep.has(key))) continue;
        const spec: Record<string, Json> = {};
        for (const name of FORMAT_KEYS) {
          const value = field[name];
          if (typeof value === 'string' || typeof value === 'boolean') spec[name] = value;
        }
        if (Object.keys(spec).length > 0) out[key] = spec;
      }
    }
  }
  return out;
}
