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

// Only the `platform` branch of requireCaller tags this, and never into `verifiedScopes`: a platform scope can then
// never be read as tenant authority (`tenantAuthorityOf`).
const verifiedPlatformScopes = new WeakMap<object, ApiScope>();
export const tagPlatformScope = (auth: object, scope: ApiScope): void => {
  verifiedPlatformScopes.set(auth, scope);
};

/** The platform scope `requireCaller` checked on this Platform key principal; undefined for anything else. */
export function verifiedPlatformScopeOf(auth: object): ApiScope | undefined {
  return verifiedPlatformScopes.get(auth);
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

/**
 * A session without console access: the handler may show it only what it started. Fail-safe: a session
 * that never passed `requireCaller`'s console check (no `consoleAccess`) counts as own-only.
 */
export const isOwnOnly = (auth: { kind: string } | undefined): boolean =>
  auth?.kind === 'session' && (auth as { consoleAccess?: boolean }).consoleAccess !== true;

/** A session `requireCaller` admitted without console access (explicit, so other guards' sessions are not refused). */
export const isMarkedOwnOnly = (auth: { kind: string }): boolean =>
  auth.kind === 'session' && (auth as { consoleAccess?: boolean }).consoleAccess === false;
