import { describe, expect, it } from 'vitest';
import { MINTABLE_SCOPES } from '../../shared/contracts/api-keys.ts';
import {
  adminPresets,
  holdableScopes,
  MINTABLE_SCOPE_CAPABILITY,
} from '../../shared/developers-keys.ts';
import { delegableScopes } from '../modules/api-keys/access.ts';
import { scopeCapability } from './api-scopes.ts';
import { ROLE_GRANTS } from './org-role-grants.ts';

describe('the admin key presets', () => {
  it('map each mintable scope to the capability the Worker checks', () => {
    for (const s of MINTABLE_SCOPES) expect(MINTABLE_SCOPE_CAPABILITY[s]).toBe(scopeCapability[s]);
  });

  it('are offered only for scopes the role may delegate', () => {
    for (const role of Object.keys(ROLE_GRANTS) as (keyof typeof ROLE_GRANTS)[]) {
      const delegable = delegableScopes({ kind: 'session', roles: [role] } as never);
      for (const mode of ['live', 'test'] as const) {
        const held = holdableScopes('personal', ROLE_GRANTS[role], mode);
        for (const p of adminPresets(held, mode))
          for (const s of p.scopes) expect(delegable).toContain(s);
      }
    }
  });

  it('hide what a narrow role cannot hold', () => {
    const ids = (role: keyof typeof ROLE_GRANTS) =>
      adminPresets(holdableScopes('personal', ROLE_GRANTS[role])).map((p) => p.id);
    expect(ids('read_only')).toEqual(['read', 'audit']);
    expect(ids('integration_admin')).toEqual(['webhooks', 'integrations']);
    expect(ids('template_author')).toEqual(['templates']);
    expect(ids('template_publisher')).toEqual([]);
    expect(ids('pass_operator')).toContain('issue');
    expect(ids('pass_operator')).not.toContain('webhooks');
    expect(ids('org_admin')).toContain('full');
  });
});
