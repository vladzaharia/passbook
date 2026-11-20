import { describe, expect, it } from 'vitest';
import { MINTABLE_SCOPES } from '../../shared/contracts/api-keys.ts';
import { OrgRoleSchema } from '../../shared/contracts/org-membership.ts';
import { effectiveScopes, ROLE_PRESETS, rolesWithScope, scopeCapability } from './api-scopes.ts';
import { rolesGranting } from './org-role-grants.ts';

describe('role presets', () => {
  it('has one preset for each of the seven roles', () => {
    expect(Object.keys(ROLE_PRESETS).sort()).toEqual([...OrgRoleSchema.options].sort());
    expect(OrgRoleSchema.options).toHaveLength(7);
  });

  it('never gives a role a scope whose capability the role lacks', () => {
    for (const role of OrgRoleSchema.options)
      for (const scope of ROLE_PRESETS[role])
        expect(rolesGranting(scopeCapability[scope]), `${role} ${scope}`).toContain(role);
  });

  it('holds only scopes a route accepts, so a role never gains a scope nobody reviewed', () => {
    for (const role of OrgRoleSchema.options)
      for (const scope of ROLE_PRESETS[role])
        expect(MINTABLE_SCOPES as readonly string[], `${role} ${scope}`).toContain(scope);
  });

  it('holds no terminal or platform scope in any role', () => {
    for (const role of OrgRoleSchema.options) {
      expect(ROLE_PRESETS[role]).not.toContain('scans:write');
      expect(ROLE_PRESETS[role].some((s) => s.startsWith('platform:'))).toBe(false);
    }
    expect(rolesWithScope('scans:write')).toEqual([]);
    expect(rolesWithScope('platform:orgs')).toEqual([]);
  });

  it('keeps the narrow roles narrow', () => {
    expect(ROLE_PRESETS.read_only.filter((s) => /:(write|manage|publish|review)$/.test(s))).toEqual(
      [],
    );
    expect(ROLE_PRESETS.template_author).toEqual(['templates:read']);
    expect(ROLE_PRESETS.pass_operator).toEqual(
      expect.arrayContaining(['passes:write', 'holders:write']),
    );
    expect(ROLE_PRESETS.pass_operator).not.toContain('scanning:write');
    expect(ROLE_PRESETS.integration_admin).not.toContain('scanning:write');
    expect(rolesWithScope('scanning:write')).toEqual(['org_admin']);
  });

  it('adds a role to the listed scopes, once each', () => {
    expect(effectiveScopes(['passes:read', 'templates:read'], ['template_author'])).toEqual([
      'passes:read',
      'templates:read',
    ]);
    expect(effectiveScopes(['passes:read'], [])).toEqual(['passes:read']);
  });
});
