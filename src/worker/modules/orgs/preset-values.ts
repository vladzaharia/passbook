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
