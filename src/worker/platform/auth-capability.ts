import type { z } from 'zod';
import type { ApiScopeSchema } from '../../shared/contracts/common.ts';
import type { OrgCapability } from '../../shared/contracts/org-membership.ts';
import { scopeExercises } from './api-scopes.ts';

type ApiScope = z.infer<typeof ApiScopeSchema>;

// Only requireCaller tags the scope it verified, so a handler can trust it.
export const verifiedScopes = new WeakMap<object, ApiScope>();

/** The scope `requireCaller` checked on this key principal; undefined for anything else. */
export function verifiedScopeOf(auth: object): ApiScope | undefined {
  return verifiedScopes.get(auth);
}

// A declared `capability` is a promise the handler proves with tenantAuthorityOf. The state hangs
// on the principal object requireCaller puts in the context, which is fresh for every request.
export const capabilityState = new WeakMap<
  object,
  { capability: OrgCapability; proven: boolean }
>();

/** Called by tenantAuthorityOf once membership (or the key's scope) is proven for `capability`. */
export function proveCapability(auth: object, capability: OrgCapability): void {
  const state = capabilityState.get(auth);
  if (!state) return;
  const scope = verifiedScopes.get(auth);
  if (state.capability === capability || (scope && scopeExercises(scope, capability)))
    state.proven = true;
}

/** True when the route declared a capability and its handler never proved it. */
export function authorityUnproven(auth: object | undefined): boolean {
  const state = auth ? capabilityState.get(auth) : undefined;
  return state !== undefined && !state.proven;
}

const ownOnly = new WeakSet<object>();
/** Marks a principal admitted without console access: the handler may show it only its own. */
export const markOwnOnly = (auth: object): void => void ownOnly.add(auth);
export const isOwnOnly = (auth: object | undefined): boolean =>
  auth !== undefined && ownOnly.has(auth);
