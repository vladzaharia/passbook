// What an organization may use (design-multi-tenancy.md section 2). Writes enforce it through the grant checks
// `entitled` and `withinLimit` (reasons `entitlement`, `limit`); this module reads it for DTOs and the read
// side. Fail closed: a missing or invalid value is a denial.
import {
  ENTITLEMENT_KEYS,
  type EntitlementKey,
  type EntitlementValue,
  entitledValue,
  parseEntitlementValue,
} from '../../shared/contracts/entitlements.ts';
import { authorityDenied } from './errors.ts';
import { entitlementRows } from './repo-entitlements.ts';
import type { ServiceContext } from './service-context.ts';

export { entitled, withinLimit } from './authority-entitled.ts';

/** The org's resolved values; a key absent here is not entitled. */
export type Entitlements = Partial<Record<EntitlementKey, EntitlementValue>>;

export async function entitlementsOf(ctx: ServiceContext, orgId: string): Promise<Entitlements> {
  const out: Entitlements = {};
  for (const row of await entitlementRows(ctx.env.DB, orgId)) {
    const key = ENTITLEMENT_KEYS.find((k) => k === row.key);
    // A stored key the registry lacks is ignored; one with an invalid value is logged and left out (denied).
    if (key === undefined) continue;
    const value = parseEntitlementValue(key, parseJson(row.value));
    if (value === undefined)
      ctx.log.error('entitlement.invalid_value', { code: 'ENTITLEMENT_INVALID', orgId, key });
    else out[key] = value;
  }
  return out;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // The column is CHECK json_valid; a failure here is not a value, so the caller treats it as invalid.
    return undefined;
  }
}

/** See `entitledValue`: `want` is the minimum level or the list item. */
export const isEntitled = (e: Entitlements, key: EntitlementKey, want?: string): boolean =>
  entitledValue(key, e[key], want);

/** Throws the `entitlement` refusal (403 `FEATURE_NOT_INCLUDED`) unless the org is entitled. */
export async function requireEntitled(
  ctx: ServiceContext,
  orgId: string,
  key: EntitlementKey,
  want?: string,
): Promise<void> {
  if (!isEntitled(await entitlementsOf(ctx, orgId), key, want))
    throw authorityDenied('entitlement');
}
