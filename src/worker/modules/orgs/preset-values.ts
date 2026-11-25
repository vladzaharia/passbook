import {
  ENTITLEMENT_KEYS,
  type EntitlementValue,
  parseEntitlementValue,
} from '../../../shared/contracts/entitlements.ts';
import type { EntitlementValues } from '../../../shared/entitlement-impact.ts';
import type { ServiceContext } from '../../platform/service-context.ts';

/** A preset's values from stored JSON (`previous_values`); a key that does not parse is left out, as everywhere. */
export function parseValuesJson(ctx: ServiceContext, text: string | null): EntitlementValues {
  let raw: unknown;
  try {
    raw = text === null ? {} : JSON.parse(text);
  } catch {
    raw = {};
  }
  const out: EntitlementValues = {};
  if (raw === null || typeof raw !== 'object') return out;
  for (const key of ENTITLEMENT_KEYS) {
    const value: EntitlementValue | undefined = parseEntitlementValue(
      key,
      (raw as Record<string, unknown>)[key],
    );
    if (value === undefined) {
      if (key in raw)
        ctx.log.error('entitlement.invalid_value', { code: 'ENTITLEMENT_INVALID', key });
      continue;
    }
    out[key] = value;
  }
  return out;
}

export function parseStored(
  ctx: ServiceContext,
  key: string,
  text: string,
): EntitlementValue | undefined {
  const known = ENTITLEMENT_KEYS.find((k) => k === key);
  if (known === undefined) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = undefined;
  }
  const value = parseEntitlementValue(known, raw);
  if (value === undefined)
    ctx.log.error('entitlement.invalid_value', { code: 'ENTITLEMENT_INVALID', key });
  return value;
}

type Held = Map<string, { value: EntitlementValue }>;

/**
 * An org's overrides as the journal sees them: `all` is every stored row (what the channels last saw until a
 * writer journals the expiry), `standing` the ones that still apply, `expired` the keys to remove with the change.
 */
export function overrideMaps(
  ctx: ServiceContext,
  rows: readonly { key: string; value: string; expires_at: number | null }[],
  now: number,
): { all: Held; standing: Held; expired: string[] } {
  const all: Held = new Map();
  const standing: Held = new Map();
  const expired: string[] = [];
  for (const o of rows) {
    const gone = o.expires_at !== null && o.expires_at <= now;
    if (gone) expired.push(o.key);
    const value = parseStored(ctx, o.key, o.value);
    if (value === undefined) continue;
    all.set(o.key, { value });
    if (!gone) standing.set(o.key, { value });
  }
  return { all, standing, expired };
}
