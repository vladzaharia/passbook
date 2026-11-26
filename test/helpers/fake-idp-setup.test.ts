import { describe, expect, it } from 'vitest';
import type { SetupCtx } from '../../src/worker/modules/idp/types.ts';
import { createFakeIdp } from './fake-idp.ts';

const ctx: SetupCtx = {
  ref: 'r',
  reason: 't',
  actor: { kind: 'system', job: 'test' },
  dryRun: false,
};
const dry: SetupCtx = { ...ctx, dryRun: true };
const TOKEN = 'a'.repeat(43);
const sha = async (t: string): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

describe('fake IDP setup', () => {
  it('walks place, allow, restrict, logo, scim, sync', async () => {
    const idp = createFakeIdp();
    expect((await idp.placeRoleGroups(ctx)).roles).toEqual({
      console: 'already',
      developer: 'already',
      support: 'created',
      platform_admin: 'already',
      users: 'already',
    });
    expect(await idp.allowClientGroups(ctx)).toEqual({
      result: 'allowed',
      added: 4,
      dryRun: false,
    });
    expect((await idp.allowClientGroups(ctx)).result).toBe('already');
    expect((await idp.restrictClient(ctx)).result).toBe('restricted');
    expect((await idp.restrictClient(ctx)).result).toBe('already');
    expect((await idp.setClientLogo(ctx)).result).toBe('set');
    expect((await idp.ensureScim(TOKEN, ctx)).result).toBe('created');
    expect((await idp.ensureScim(TOKEN, ctx)).result).toBe('already');
    expect((await idp.ensureScim('b'.repeat(43), ctx)).result).toBe('rotated');
    expect((await idp.syncScim(ctx)).result).toBe('synced');
    expect(idp.setup.scim.lastSyncedAt).not.toBeNull();
  });

  it('refuses to restrict a client that would lock the admins out', async () => {
    const idp = createFakeIdp();
    await expect(idp.restrictClient(ctx)).rejects.toThrow('IDP_CLIENT: client_lockout');
    await expect(idp.ensureScim(TOKEN, ctx)).rejects.toThrow('IDP_CLIENT: client_open');
  });

  it('refuses a provider the owner pointed elsewhere, and never deletes', async () => {
    const idp = createFakeIdp();
    idp.setup.client.restricted = true;
    idp.setup.scim.exists = true;
    idp.setup.scim.foreign = true;
    await expect(idp.ensureScim(TOKEN, ctx)).rejects.toThrow('IDP_SCIM_FOREIGN');
    await expect(idp.syncScim(ctx)).rejects.toThrow('IDP_SCIM_FOREIGN');
    expect(idp.setup.scim.exists).toBe(true);
  });

  it('a dry run writes nothing, even in live mode; frozen refuses', async () => {
    const idp = createFakeIdp();
    idp.setup.client.restricted = true;
    expect((await idp.placeRoleGroups(dry)).dryRun).toBe(true);
    await expect(idp.allowClientGroups(dry)).rejects.toThrow('A role group is not placed.');
    await idp.setClientLogo(dry);
    expect(idp.writes).toBe(0);
    expect(idp.groupStore.has('support')).toBe(false);
    expect(idp.setup.client.allowed.size).toBe(0);
    await idp.freeze('why', ctx);
    await expect(idp.setClientLogo(ctx)).rejects.toThrow('IDP_FROZEN');
  });

  it('setup writes ignore the write mode', async () => {
    const idp = createFakeIdp({ mode: 'dry_run' });
    await idp.placeRoleGroups(ctx);
    expect((await idp.allowClientGroups(ctx)).dryRun).toBe(false);
    expect(idp.writes).toBe(2);
  });

  it('setupStatus hashes the token and never returns it', async () => {
    const idp = createFakeIdp();
    idp.setup.client.restricted = true;
    await idp.ensureScim(TOKEN, ctx);
    const status = await idp.setupStatus({ tokenHashes: ['x', await sha(TOKEN)] });
    expect(status.scim).toMatchObject({ exists: true, endpointOk: true, token: 1 });
    expect(JSON.stringify(status)).not.toContain(TOKEN);
    expect((await idp.setupStatus({ tokenHashes: [] })).scim.token).toBe('other');
    expect(status.client.missingRoles).toEqual(['console', 'developer']);
  });

  it('refuses a call without an explicit boolean dryRun, before any write', async () => {
    const idp = createFakeIdp();
    const { dryRun: _d, ...bare } = ctx;
    const calls = [
      idp.placeRoleGroups(bare as SetupCtx),
      idp.allowClientGroups(bare as SetupCtx),
      idp.restrictClient({ ...bare, dryRun: 'no' } as unknown as SetupCtx),
      idp.setClientLogo(bare as SetupCtx),
      idp.ensureScim(TOKEN, bare as SetupCtx),
      idp.syncScim(bare as SetupCtx),
    ];
    for (const call of calls) await expect(call).rejects.toThrow('IDP_REFUSED');
    expect(idp.writes).toBe(0);
  });

  it('refuses what the binding refuses: open logo, open sync, unplaced roles, foreign callbacks', async () => {
    const idp = createFakeIdp();
    await expect(idp.setClientLogo(ctx)).rejects.toThrow('IDP_CLIENT: client_open');
    idp.setup.scim.exists = true;
    await expect(idp.syncScim(ctx)).rejects.toThrow('IDP_CLIENT: client_open');
    await expect(idp.allowClientGroups(ctx)).rejects.toThrow('IDP_REFUSED');
    await idp.placeRoleGroups(ctx);
    idp.setup.client.callbacksOurs = false;
    for (const call of [
      idp.allowClientGroups(ctx),
      idp.restrictClient(ctx),
      idp.setClientLogo(ctx),
    ])
      await expect(call).rejects.toThrow('IDP_CLIENT: client_foreign_callbacks');
    expect((await idp.setupStatus()).client.callbacksOurs).toBe(false);
  });

  it('refuses every setup write while a recorded group was renamed', async () => {
    const idp = createFakeIdp();
    idp.setup.groupDrift = true;
    await expect(idp.placeRoleGroups(ctx)).rejects.toThrow('group_name_mismatch');
    await expect(idp.allowClientGroups(ctx)).rejects.toThrow('IDP_UNSAFE_CONFIG');
    await expect(idp.restrictClient(ctx)).rejects.toThrow('IDP_UNSAFE_CONFIG');
    expect(idp.writes).toBe(0);
  });

  it('models protected, missing, adoptable and in-use groups', async () => {
    const idp = createFakeIdp();
    idp.setup.protectedGroups.platform_admin = 'missing';
    idp.setup.protectedGroups.users = 'found';
    idp.setup.existing.support = 'in_use';
    expect((await idp.setupStatus()).roles).toMatchObject({
      platform_admin: 'missing',
      users: 'adopt',
      support: 'in_use',
    });
    expect((await idp.placeRoleGroups(ctx)).roles).toMatchObject({
      platform_admin: 'missing',
      users: 'recorded',
      support: 'in_use',
    });
    expect(idp.setup.protectedGroups.users).toBe('recorded');
    expect(idp.groupStore.has('support')).toBe(false);
    idp.setup.existing.support = 'adoptable';
    expect((await idp.placeRoleGroups(ctx)).roles.support).toBe('adopted');
    expect(idp.groupStore.has('support')).toBe(true);
  });

  it('refuses to restrict while an existing alias group is not allowed', async () => {
    const idp = createFakeIdp();
    idp.setup.alias.exists = true;
    await idp.placeRoleGroups(ctx);
    idp.setup.client.allowed.add('platform_admin');
    await expect(idp.restrictClient(ctx)).rejects.toThrow('IDP_CLIENT: client_lockout');
    await idp.allowClientGroups(ctx);
    expect((await idp.restrictClient(ctx)).result).toBe('restricted');
  });
});
