import { describe, expect, it } from 'vitest';
import type { WriteCtx } from '../../src/worker/modules/idp/types.ts';
import { createFakeIdp } from './fake-idp.ts';

const ctx: WriteCtx = { ref: 'r', reason: 't', actor: { kind: 'system', job: 'test' } };

describe('fake IDP', () => {
  it('signup grants the kind roles to a created account', async () => {
    const idp = createFakeIdp();
    const s = await idp.createSignup('member_developer', ctx);
    if ('dryRun' in s) throw new Error('dry');
    idp.completeSignup(s.tokenId, 'u1');
    await idp.proveSignup([s.tokenId]);
    expect(await idp.lookup('u1')).toMatchObject({
      class: 'created',
      grants: ['developer', 'console'],
    });
  });

  it('dry run answers without writing', async () => {
    const idp = createFakeIdp();
    idp.addAccount('u', { class: 'created' });
    expect(await idp.createSignup('member', { ...ctx, dryRun: true })).toEqual({ dryRun: true });
    expect(await idp.apply('u', { add: ['console'] }, { ...ctx, dryRun: true })).toMatchObject({
      added: ['console'],
      dryRun: true,
    });
    expect(await idp.setDisabled('u', true, { ...ctx, dryRun: true })).toEqual({
      result: 'disabled',
      dryRun: true,
    });
    expect(idp.writes).toBe(0);
    expect((await idp.lookup('u')).roles).toEqual([]);
    const live = createFakeIdp({ mode: 'dry_run' });
    live.addAccount('u');
    await live.apply('u', { add: ['console'] }, ctx);
    expect(live.writes).toBe(0);
  });

  it('removes only roles it added unless overridden', async () => {
    const idp = createFakeIdp();
    idp.addAccount('u', { roles: ['console'] });
    expect((await idp.apply('u', { remove: ['console'] }, ctx)).skipped).toEqual([
      { role: 'console', reason: 'not_ours' },
    ]);
    expect(
      (await idp.apply('u', { remove: ['console'] }, { ...ctx, override: true })).removed,
    ).toEqual(['console']);
    expect((await idp.apply('u', { remove: ['console'] }, ctx)).skipped[0]?.reason).toBe('absent');
  });

  it('refuses admins, adds to disabled accounts and unmanaged disables', async () => {
    const idp = createFakeIdp();
    idp.addAccount('admin', { isAdmin: true });
    idp.addAccount('off', { class: 'created', disabled: true });
    idp.addAccount('ext', { class: 'external' });
    await expect(idp.apply('admin', { add: ['console'] }, ctx)).rejects.toThrow(/^IDP_REFUSED/);
    await expect(idp.apply('off', { add: ['console'] }, ctx)).rejects.toThrow(/^IDP_REFUSED/);
    await expect(idp.setDisabled('ext', true, ctx)).rejects.toThrow(/^IDP_NOT_MANAGED/);
    await expect(idp.lookup('nobody')).rejects.toThrow(/^IDP_NOT_FOUND/);
  });

  it('finds exactly one verified, enabled, non-admin email match', async () => {
    const idp = createFakeIdp();
    idp.addAccount('a', { email: 'a@x.test', emailVerified: true });
    idp.addAccount('b', { email: 'b@x.test', emailVerified: false });
    expect(await idp.findByVerifiedEmail('A@x.test', ctx)).toEqual({ subject: 'a' });
    expect(await idp.findByVerifiedEmail('b@x.test', ctx)).toBeNull();
  });

  it('freeze answers every write with IDP_FROZEN and has no thaw', async () => {
    const idp = createFakeIdp();
    idp.addAccount('u', { class: 'created' });
    expect(await idp.freeze('why', ctx)).toBe('frozen');
    expect(await idp.freeze('again', ctx)).toBe('already');
    await expect(idp.createSignup('member', ctx)).rejects.toThrow(/^IDP_FROZEN/);
    await expect(idp.apply('u', { add: ['console'] }, ctx)).rejects.toThrow(/^IDP_FROZEN/);
    await expect(idp.setDisabled('u', true, ctx)).rejects.toThrow(/^IDP_FROZEN/);
    expect((await idp.lookup('u')).roles).toEqual([]);
    expect(idp.writes).toBe(0);
  });

  it('re-enables only what it disabled and protects admins, the key user and me', async () => {
    const idp = createFakeIdp({ keyUser: 'key' });
    idp.addAccount('ours', { class: 'created' });
    idp.addAccount('theirs', { class: 'created', disabled: true });
    idp.addAccount('pa', { class: 'created', roles: ['platform_admin'] });
    idp.addAccount('key', { class: 'created' });
    idp.addAccount('me', { class: 'created' });
    await idp.setDisabled('ours', true, ctx);
    expect(await idp.setDisabled('ours', false, ctx)).toMatchObject({ result: 'enabled' });
    await expect(idp.setDisabled('theirs', false, ctx)).rejects.toThrow(/^IDP_REFUSED/);
    for (const s of ['pa', 'key', 'me']) {
      await expect(idp.apply(s, { add: ['console'] }, ctx)).rejects.toThrow(/^IDP_REFUSED/);
      await expect(idp.setDisabled(s, true, ctx)).rejects.toThrow(/^IDP_REFUSED/);
    }
  });

  it('simulates the budget and the breaker', async () => {
    const budget = createFakeIdp({ budget: 1 });
    budget.addAccount('u');
    await budget.apply('u', { add: ['console'] }, ctx);
    await expect(budget.apply('u', { add: ['developer'] }, ctx)).rejects.toThrow(/^IDP_BUDGET/);
    const breaker = createFakeIdp({ breaker: 0 });
    await expect(breaker.createSignup('member', ctx)).rejects.toThrow(/^IDP_BREAKER/);
  });
});
