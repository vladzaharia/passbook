import { beforeEach, describe, expect, it } from 'vitest';
import { parseRegistry } from '../../workers/passbook-id-connector/src/registry.ts';
import { baseEnv, ctx, groupsJson, resetLedger, setup } from './harness.ts';

beforeEach(resetLedger);

describe('registry', () => {
  it('maps roles to ids and marks platform admins and users read only', () => {
    const { registry, reasons } = parseRegistry(baseEnv());
    expect(reasons).toEqual([]);
    expect(registry?.writableId('console')).toBe('g-console');
    expect(registry?.writableId('developer')).toBe('g-dev');
    expect(registry?.writableId('support')).toBeUndefined();
    expect(registry?.writableId('platform_admin')).toBeUndefined();
    expect(registry?.writableId('users')).toBeUndefined();
    expect(registry?.protectedIds).toEqual(['g-admins', 'g-users']);
  });

  it('accepts support only when the registry lists it', async () => {
    const off = setup();
    off.pocket.addUser('u1');
    await expect(off.api.apply('u1', { add: ['support'] }, ctx())).rejects.toThrow(/not mapped/);
    await resetLedger();
    const on = setup('v2', { GROUPS: groupsJson({ support: true }) });
    on.pocket.addUser('u1');
    await expect(on.api.apply('u1', { add: ['support'] }, ctx())).resolves.toMatchObject({
      added: ['support'],
    });
    expect(on.pocket.s.users.get('u1')?.groups).toEqual(['g-other', 'g-support']);
  });

  it('blocks every write when a registered group is renamed in Polaris ID', async () => {
    const { api, pocket } = setup();
    pocket.s.groupNames['g-console'] = 'wallet_org_admins';
    pocket.addUser('u1');
    expect((await api.health()).unsafe).toEqual(['group_name_mismatch:console']);
    await expect(api.apply('u1', { add: ['developer'] }, ctx())).rejects.toThrow(
      /^IDP_UNSAFE_CONFIG/,
    );
    await expect(api.createSignup({ kind: 'developer' }, ctx())).rejects.toThrow(
      /^IDP_UNSAFE_CONFIG/,
    );
    expect(pocket.writes()).toHaveLength(0);
  });

  it('blocks every write when a registered group is gone', async () => {
    const { api, pocket } = setup();
    pocket.s.missing.add('g-console');
    pocket.addUser('u1');
    await expect(api.apply('u1', { add: ['developer'] }, ctx())).rejects.toThrow(
      /^IDP_UNSAFE_CONFIG/,
    );
    expect(pocket.writes()).toHaveLength(0);
  });

  it('exposes no method that takes a group id or name', async () => {
    const { api, pocket } = setup();
    // Every method's parameters are subjects, kinds, roles, token ids, an email or a context.
    expect(Object.keys(api).sort()).toEqual(
      [
        'apply',
        'claims',
        'createGroup',
        'deleteGroup',
        'ensureRoleGroup',
        'groups',
        'setClaims',
        'updateGroup',
        'calls',
        'createSignup',
        'deleteSignup',
        'findByVerifiedEmail',
        'freeze',
        'health',
        'lookup',
        'proveSignup',
        'setDisabled',
        'snapshot',
      ].sort(),
    );
    pocket.addUser('u1');
    const hostile = api.apply as unknown as (...a: unknown[]) => Promise<unknown>;
    await expect(
      hostile('u1', { add: ['developer'], groupId: 'g-admins' }, ctx()),
    ).resolves.toMatchObject({ added: ['developer'] });
    expect(pocket.writes().at(-1)?.body).toEqual({ userGroupIds: ['g-other', 'g-dev'] });
  });
});
