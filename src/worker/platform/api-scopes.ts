import type { z } from 'zod';
import {
  CREDENTIAL_SCOPES,
  MINTABLE_SCOPES,
  TEST_ONLY_SCOPES,
} from '../../shared/contracts/api-keys.ts';
import type { ApiScopeSchema, Mode } from '../../shared/contracts/common.ts';
import type { OrgCapability, OrgRole } from '../../shared/contracts/org-membership.ts';
import { OrgRoleSchema } from '../../shared/contracts/org-membership.ts';
import { rolesGranting } from './org-role-grants.ts';

export { CREDENTIAL_SCOPES };

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
  'scan-setup:read': 'scanning:read',
  'scan-setup:write': 'scanning:manage',
  'scanning:admin': 'scanning:manage',
  'nfc:keys': 'scanning:manage',
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
  'brand:manage': 'org:manage',
};

/** A write scope that has always served the read capability of its area too. */
const ALSO_READS: Partial<Record<TenantScope, OrgCapability>> = {
  'webhooks:manage': 'integrations:read',
  'messages:write': 'messages:read',
  'brand:manage': 'org:read',
};

/** `scans:write` is the terminal scope (its own guard); it stands for `passes:operate` only where a call site opts in (`tenantAuthorityOf`'s `tillKey`, roll call). */
const NOT_TENANT_AUTHORITY: readonly ApiScope[] = ['scans:write'];

/** Whether a key holding `scope` may exercise `capability` in the org it belongs to. */
export function scopeExercises(scope: ApiScope, capability: OrgCapability): boolean {
  if (isPlatformScope(scope) || NOT_TENANT_AUTHORITY.includes(scope)) return false;
  return scopeCapability[scope] === capability || ALSO_READS[scope] === capability;
}

/**
 * Org scopes a role stands for: those a route accepts (`MINTABLE_SCOPES`), so a role token never holds a scope
 * nobody reviewed, and never `scans:write`, a terminal's scope (bound to its terminals), never a credential scope.
 */
const presetScope = (scope: TenantScope) =>
  !NOT_TENANT_AUTHORITY.includes(scope) &&
  // Reading the org's audit log is named on a key, never carried by a role.
  scope !== 'audit:read' &&
  // Tags open doors: named on a key, never carried by a role.
  scope !== 'nfc:read' &&
  scope !== 'nfc:write' &&
  !(CREDENTIAL_SCOPES as readonly string[]).includes(scope) &&
  (MINTABLE_SCOPES as readonly string[]).includes(scope);

/**
 * The seven role presets as scope bundles: a role holds each org scope whose capability the role's
 * membership grants, so a preset never exceeds the role and a scope added later reaches role tokens
 * with no edit here. The bundle is written onto a key at mint; a role label is not evaluated again later.
 */
export const ROLE_PRESETS: Record<OrgRole, TenantScope[]> = Object.fromEntries(
  OrgRoleSchema.options.map((role) => [
    role,
    (Object.keys(scopeCapability) as TenantScope[]).filter(
      (scope) => presetScope(scope) && rolesGranting(scopeCapability[scope]).includes(role),
    ),
  ]),
) as Record<OrgRole, TenantScope[]>;

/** Roles whose membership grants what `scope` exercises (the cap on a personal key). */
export const rolesCapableOf = (scope: string): OrgRole[] =>
  isPlatformScope(scope as ApiScope) || !(scope in scopeCapability)
    ? []
    : rolesGranting(scopeCapability[scope as TenantScope]);

/** The scopes written onto a key at mint: its own plus those of its roles, once each. A Live key's bundle leaves out the Test-only scopes. Read once, never again. */
export const effectiveScopes = (
  scopes: readonly ApiScope[],
  roles: readonly OrgRole[],
  mode: Mode = 'test',
): ApiScope[] => [
  ...new Set([
    ...scopes,
    ...roles
      .flatMap((role) => ROLE_PRESETS[role])
      .filter(
        (scope) => mode === 'test' || !(TEST_ONLY_SCOPES as readonly string[]).includes(scope),
      ),
  ]),
];
