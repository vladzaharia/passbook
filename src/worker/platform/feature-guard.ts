// The request guard for entitlements (design-multi-tenancy.md section 2.3, MT2). A route declares
// `RouteAuth.feature`; `requireCaller` records it on the principal, and the org's entitlements are
// checked once the org is known: at once for an org-bound key, in `tenantAuthorityOf` for a session or a
// platform key. Fail closed: no row, no key or an invalid value refuses. A Test principal gets a
// Test-waivable key in full (billing AD5) only on a route that opts in with `testWaived`: one whose object
// carries the principal's mode, never an org-wide write.

import type { Mode } from '../../shared/contracts/common.ts';
import { isTestWaivable, valuesInMode } from '../../shared/contracts/entitlements/test-waivable.ts';
import {
  type EntitlementKey,
  entitlementDef,
  levelsAtLeast,
} from '../../shared/contracts/entitlements.ts';
import { featureNotIncluded } from '../../shared/copy/entitlements.ts';
import type { AuthContext } from './auth.ts';
import { type Entitlements, entitlementsOf, isEntitled } from './entitlements.ts';
import { FeatureNotIncludedError } from './errors.ts';
import type { ServiceContext } from './service-context.ts';

/**
 * A key, or a key with the lowest level that passes (levels) and `testWaived` for a route whose object
 * carries the principal's mode, so a Test principal gets the key in full.
 */
export type FeatureRule =
  | EntitlementKey
  | { key: EntitlementKey; atLeast?: string; testWaived?: true };

export const featureKeyOf = (rule: FeatureRule): EntitlementKey =>
  typeof rule === 'string' ? rule : rule.key;

const atLeastOf = (rule: FeatureRule): string | undefined =>
  typeof rule === 'string' ? undefined : rule.atLeast;

const waivesIn = (rule: FeatureRule, mode: Mode | undefined): boolean =>
  typeof rule !== 'string' && rule.testWaived === true && mode === 'test';

/**
 * Throws when a declaration cannot mean what it says: a bare level or list key, `atLeast` on anything but
 * a level, or `testWaived` on a key that is never waived.
 */
export function checkFeatureRule(where: string, rule: FeatureRule): void {
  const key = featureKeyOf(rule);
  const def = entitlementDef(key);
  const atLeast = atLeastOf(rule);
  if (typeof rule !== 'string' && rule.testWaived && (!isTestWaivable(key) || def.kind === 'limit'))
    throw new Error(`${where}: feature ${key} is not Test-waivable, so it takes no testWaived`);
  if (def.kind === 'list')
    throw new Error(`${where}: feature ${key} is a list; a route cannot guard it`);
  if (def.kind === 'level' && (atLeast === undefined || levelsAtLeast(key, atLeast).length === 0))
    throw new Error(
      `${where}: feature ${key} needs { key, atLeast } with one of ${def.levels.join(', ')}`,
    );
  if (def.kind !== 'level' && atLeast !== undefined)
    throw new Error(`${where}: feature ${key} is not a level, so it takes no atLeast`);
}

interface FeatureState {
  /** The route's declaration: it must be checked before the handler may succeed. */
  declared: readonly FeatureRule[];
  /** Applied without a declaration (the `api` level of a key). */
  implicit: readonly FeatureRule[];
  /** Orgs already checked for this principal. */
  checked: Set<string>;
  waived: boolean;
}

// On the principal object requireCaller puts in the context, fresh for every request.
const states = new WeakMap<AuthContext, FeatureState>();

/** Called by requireCaller. A principal with nothing to check gets no state. */
export function trackFeatures(
  auth: AuthContext,
  declared: FeatureRule | undefined,
  implicit: FeatureRule | undefined,
): void {
  if (declared === undefined && implicit === undefined) return;
  states.set(auth, {
    declared: declared === undefined ? [] : [declared],
    implicit: implicit === undefined ? [] : [implicit],
    checked: new Set(),
    waived: false,
  });
}

/**
 * Refuses (403 FEATURE_NOT_INCLUDED, `feature` named) unless the org's entitlements satisfy every rule the
 * principal carries. One query per org per request. Called with an org the principal is already proven for.
 */
export async function enforceFeatures(
  ctx: ServiceContext,
  auth: AuthContext,
  orgId: string,
): Promise<void> {
  const state = states.get(auth);
  if (!state || state.checked.has(orgId)) return;
  const stored = await entitlementsOf(ctx, orgId);
  for (const rule of [...state.implicit, ...state.declared]) {
    const key = featureKeyOf(rule);
    const values = waivesIn(rule, auth.mode) ? valuesInMode(stored, 'test') : stored;
    if (!isEntitled(values, key, atLeastOf(rule)))
      throw new FeatureNotIncludedError(key, featureNotIncluded(key));
  }
  state.checked.add(orgId);
}

/** The org's entitlements as seen in `mode`: in Test, the waivable keys are full (billing AD5). */
export async function entitlementsIn(
  ctx: ServiceContext,
  orgId: string,
  mode: Mode,
): Promise<Entitlements> {
  return valuesInMode(await entitlementsOf(ctx, orgId), mode);
}

/** `isEntitled` for work in one mode. Use it wherever the objects the feature acts on carry a mode. */
export async function entitledIn(
  ctx: ServiceContext,
  orgId: string,
  key: EntitlementKey,
  mode: Mode,
  want?: string,
): Promise<boolean> {
  return isEntitled(await entitlementsIn(ctx, orgId, mode), key, want);
}

/**
 * A declared feature belongs to an organization. A handler that legitimately acts on none (a platform
 * admin working on platform-owned records) says so here; anything else that never reaches the check is a
 * server fault (`register` answers 500 FEATURE_UNCHECKED).
 */
export function waiveFeature(auth: AuthContext): void {
  const state = states.get(auth);
  if (state) state.waived = true;
}

/** True when the route declared a feature and its handler never checked an org or waived it. */
export function featureUnchecked(auth: AuthContext | undefined): boolean {
  const state = auth ? states.get(auth) : undefined;
  return (
    state !== undefined && state.declared.length > 0 && !state.waived && state.checked.size === 0
  );
}
