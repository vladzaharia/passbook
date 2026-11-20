import type { z } from 'zod';
import type { ApiScopeSchema } from '../../shared/contracts/common.ts';
import type { OrgCapability } from '../../shared/contracts/org-membership.ts';

type ApiScope = z.infer<typeof ApiScopeSchema>;

/** Scopes only a platform admin acts on. No org capability stands behind them. */
export type PlatformScope = Extract<ApiScope, `platform:${string}`>;
export type TenantScope = Exclude<ApiScope, PlatformScope>;

export const isPlatformScope = (scope: ApiScope): scope is PlatformScope =>
  scope.startsWith('platform:');

/**
 * The one capability each org scope exercises. Scopes stay finer than capabilities: collapsing
 * them would widen live keys (`webhooks:manage` would gain connections). Adding a scope to
 * `ApiScopeSchema` fails the build until it has a row here.
 */
export const scopeCapability: Record<TenantScope, OrgCapability> = {
  'passes:read': 'passes:read',
  'passes:write': 'passes:operate',
  'holders:write': 'passes:operate',
  'templates:read': 'templates:read',
  'templates:write': 'templates:author',
  'templates:review': 'templates:review',
  'templates:publish': 'templates:publish',
  'messages:read': 'messages:read',
  'messages:write': 'messages:manage',
  'scans:read': 'scanning:read',
  'scans:write': 'passes:operate',
  'scanning:write': 'scanning:manage',
  'nfc:read': 'passes:read',
  'nfc:write': 'passes:operate',
  'connections:read': 'integrations:read',
  'connections:write': 'integrations:manage',
  'webhooks:manage': 'integrations:manage',
  'wallet:read': 'integrations:read',
  'wallet:write': 'integrations:manage',
  'api-keys:write': 'integrations:manage',
  'org:read': 'org:read',
  'org:write': 'org:manage',
  'members:read': 'members:read',
  'members:write': 'members:manage',
  'audit:read': 'audit:read',
};

/** A write scope that has always served the read capability of its area too. */
const ALSO_READS: Partial<Record<TenantScope, OrgCapability>> = {
  'webhooks:manage': 'integrations:read',
  'messages:write': 'messages:read',
};

/** `scans:write` is the terminal scope (its own guard); it never stands for `passes:operate`. */
const NOT_TENANT_AUTHORITY: readonly ApiScope[] = ['scans:write'];

/** Whether a key holding `scope` may exercise `capability` in the org it belongs to. */
export function scopeExercises(scope: ApiScope, capability: OrgCapability): boolean {
  if (isPlatformScope(scope) || NOT_TENANT_AUTHORITY.includes(scope)) return false;
  return scopeCapability[scope] === capability || ALSO_READS[scope] === capability;
}
