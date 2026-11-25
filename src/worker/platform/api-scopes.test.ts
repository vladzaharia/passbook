import { describe, expect, it } from 'vitest';
import { CREDENTIAL_SCOPES, MINTABLE_SCOPES } from '../../shared/contracts/api-keys.ts';
import { OrgRoleSchema } from '../../shared/contracts/org-membership.ts';
import { effectiveScopes, ROLE_PRESETS, scopeCapability } from './api-scopes.ts';
import { rolesGranting } from './org-role-grants.ts';

describe('role presets', () => {
  // A bundle is copied onto a key when it is minted. Changing one is a reviewed diff of this snapshot:
  // it reaches only keys made afterwards. `api-keys:write` joined with child keys (WP6): a role key made from now holds it.
  it('are these bundles exactly', () => {
    expect(ROLE_PRESETS).toEqual({
      org_admin: [
        'passes:read',
        'passes:write',
        'holders:write',
        'templates:read',
        'templates:write',
        'templates:review',
        'templates:publish',
        'messages:write',
        'scans:read',
        'scanning:write',
        'scan-setup:read',
        'connections:read',
        'connections:write',
        'webhooks:manage',
        'wallet:write',
        'api-keys:write',
        'org:read',
        'org:write',
        'brand:manage',
      ],
      integration_admin: [
        'templates:read',
        'connections:read',
        'connections:write',
        'webhooks:manage',
        'wallet:write',
        'api-keys:write',
        'org:read',
      ],
      template_author: ['templates:read', 'templates:write', 'org:read'],
      template_reviewer: ['templates:read', 'templates:review', 'org:read'],
      template_publisher: ['templates:read', 'templates:publish', 'org:read'],
      pass_operator: [
        'passes:read',
        'passes:write',
        'holders:write',
        'templates:read',
        'messages:write',
        'scans:read',
        'scan-setup:read',
        'org:read',
      ],
      read_only: [
        'passes:read',
        'templates:read',
        'scans:read',
        'scan-setup:read',
        'connections:read',
        'org:read',
      ],
    });
  });

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
  });

  it('keeps the narrow roles narrow', () => {
    expect(ROLE_PRESETS.read_only.filter((s) => /:(write|manage|publish|review)$/.test(s))).toEqual(
      [],
    );
    expect(ROLE_PRESETS.template_author).toEqual(['templates:read', 'templates:write', 'org:read']);
    // Only org_admin changes the org's setup; integration_admin turns wallet accounts on and nothing else there.
    expect(ROLE_PRESETS.integration_admin).not.toContain('org:write');
    expect(ROLE_PRESETS.pass_operator).not.toContain('org:write');
    expect(ROLE_PRESETS.pass_operator).not.toContain('wallet:write');
    expect(ROLE_PRESETS.pass_operator).toEqual(
      expect.arrayContaining(['passes:write', 'holders:write']),
    );
    expect(ROLE_PRESETS.pass_operator).not.toContain('scanning:write');
    expect(ROLE_PRESETS.integration_admin).not.toContain('scanning:write');
    expect(ROLE_PRESETS.org_admin).toContain('scanning:write');
    for (const role of OrgRoleSchema.options)
      for (const scope of CREDENTIAL_SCOPES) expect(ROLE_PRESETS[role]).not.toContain(scope);
  });

  it('adds a role to the listed scopes, once each', () => {
    expect(effectiveScopes(['passes:read', 'templates:read'], ['template_author'])).toEqual([
      'passes:read',
      'templates:read',
      'templates:write',
      'org:read',
    ]);
    expect(effectiveScopes(['passes:read'], [])).toEqual(['passes:read']);
  });
});
