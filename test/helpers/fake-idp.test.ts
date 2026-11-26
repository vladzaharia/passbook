import { describe, expect, it } from 'vitest';
import type { WriteCtx } from '../../src/worker/modules/idp/types.ts';
import { createFakeIdp } from './fake-idp.ts';

const ctx: WriteCtx = { ref: 'r', reason: 't', actor: { kind: 'system', job: 'test' } };

describe('fake IDP', () => {
  it('signup grants the kind roles to a created account', async () => {
    const idp = createFakeIdp();
    const s = await idp.createSignup({ kind: 'member_developer' }, ctx);
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
    expect(await idp.createSignup({ kind: 'member' }, { ...ctx, dryRun: true })).toEqual({
      dryRun: true,
    });
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
    await expect(idp.createSignup({ kind: 'member' }, ctx)).rejects.toThrow(/^IDP_FROZEN/);
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
    await expect(idp.setDisabled('theirs', false, ctx)).rejects.toThrow(/^IDP_NOT_MANAGED/);
    for (const s of ['pa', 'key', 'me']) {
      await expect(idp.apply(s, { add: ['console'] }, ctx)).rejects.toThrow(/^IDP_REFUSED/);
      await expect(idp.setDisabled(s, true, ctx)).rejects.toThrow(/^IDP_REFUSED/);
    }
  });

  it('simulates the budget and the breaker', async () => {
    const budget = createFakeIdp({ budget: { apply_add_system: 1 } });
    budget.addAccount('u');
    await budget.apply('u', { add: ['console'] }, ctx);
    await expect(budget.apply('u', { add: ['developer'] }, ctx)).rejects.toThrow(/^IDP_BUDGET/);
    const breaker = createFakeIdp({ breaker: 0 });
    breaker.addAccount('u', { roles: ['console'] });
    await expect(
      breaker.apply('u', { remove: ['console'] }, { ...ctx, override: true }),
    ).rejects.toThrow(/^IDP_BREAKER/);
  });

  it('creates groups without adopting, and refuses to delete one in use', async () => {
    const idp = createFakeIdp();
    idp.addAccount('u', { class: 'created' });
    const g = await idp.createGroup('crew', 'Crew', ctx);
    expect(g).toEqual({ key: 'crew' });
    expect((await idp.groups()).find((x) => x.key === 'crew')).toMatchObject({
      kind: 'custom',
      members: 0,
    });
    await expect(idp.createGroup('crew', 'Crew', ctx)).rejects.toThrow(/^IDP_CONFLICT/);
    await expect(idp.createGroup('Bad Key', 'Crew', ctx)).rejects.toThrow(/^IDP_REFUSED/);
    await expect(idp.createGroup('console', 'Crew', ctx)).rejects.toThrow(/^IDP_REFUSED/);
    await expect(idp.ensureRoleGroup('console', ctx)).rejects.toThrow(/^IDP_REFUSED/);
    expect(await idp.ensureRoleGroup('support', ctx)).toEqual({ key: 'support' });
    await idp.apply('u', { add: ['g:crew'] }, ctx);
    expect((await idp.groups()).find((x) => x.key === 'crew')?.members).toBe(1);
    await expect(idp.deleteGroup('crew', ctx)).rejects.toThrow(/^IDP_IN_USE/);
    await idp.apply('u', { remove: ['g:crew'] }, ctx);
    await expect(idp.deleteGroup('support', ctx)).rejects.toThrow(/^IDP_REFUSED/);
    expect(await idp.deleteGroup('crew', { ...ctx, dryRun: true })).toEqual({ dryRun: true });
    expect(await idp.deleteGroup('crew', ctx)).toEqual({ key: 'crew' });
    await expect(idp.deleteGroup('crew', ctx)).rejects.toThrow(/^IDP_NOT_FOUND/);
    await expect(idp.apply('u', { add: ['g:nope'] }, ctx)).rejects.toThrow(/^IDP_REFUSED/);
  });

  it('merges claims, keeps other apps untouched and refuses reserved or unlisted keys', async () => {
    const idp = createFakeIdp({ claimKeys: ['tier'] });
    idp.addAccount('u', { class: 'linked', otherClaims: { theirs: 'x' } });
    idp.addAccount('ext', { class: 'external' });
    const text = { type: 'text', value: '123' } as const;
    await idp.setClaims({ subject: 'u' }, { passbook_a: text, tier: text }, ctx);
    await idp.setClaims({ subject: 'u' }, { passbook_b: { type: 'number', value: 2 } }, ctx);
    const view = await idp.claims({ subject: 'u' });
    expect(Object.keys(view.claims).sort()).toEqual(['passbook_a', 'passbook_b', 'tier']);
    expect(view.claims.passbook_a).toEqual(text);
    expect(view.otherKeys).toBe(1);
    expect(await idp.setClaims({ subject: 'u' }, { passbook_a: null }, ctx)).toMatchObject({
      removed: ['passbook_a'],
    });
    for (const key of ['email', 'picture', 'other', 'passbook_']) {
      await expect(idp.setClaims({ subject: 'u' }, { [key]: text }, ctx)).rejects.toThrow(
        /^IDP_REFUSED/,
      );
    }
    await expect(idp.setClaims({ subject: 'ext' }, { tier: text }, ctx)).rejects.toThrow(
      /^IDP_REFUSED/,
    );
    await idp.setClaims({ group: 'console' }, { passbook_g: text }, ctx);
    expect((await idp.claims({ group: 'console' })).claims).toHaveProperty('passbook_g');
    await expect(idp.claims({ subject: 'nobody' })).rejects.toThrow(/^IDP_NOT_FOUND/);
    const before = await idp.claims({ subject: 'u' });
    await idp.setClaims({ subject: 'u' }, { passbook_z: text }, { ...ctx, dryRun: true });
    expect(await idp.claims({ subject: 'u' })).toEqual(before);
  });

  it('signup specs carry groups, and the proof matches the invited email', async () => {
    const idp = createFakeIdp();
    await idp.createGroup('crew', 'Crew', ctx);
    // A platform signup may carry no group: groups reach the account only after its address matches.
    expect(await idp.createSignup({ kind: 'platform' }, ctx)).toHaveProperty('tokenId');
    await expect(idp.createSignup({ kind: 'member', groups: ['nope'] }, ctx)).rejects.toThrow(
      /^IDP_REFUSED/,
    );
    const s = await idp.createSignup({ kind: 'platform', groups: ['crew'] }, ctx);
    if ('dryRun' in s) throw new Error('dry');
    idp.completeSignup(s.tokenId, 'p1', { email: 'p@x.test', emailVerified: true });
    expect(await idp.proveSignup([s.tokenId], { email: 'P@x.test' })).toMatchObject({
      subject: 'p1',
      emailMatch: 'match',
    });
    expect((await idp.lookup('p1')).grants).toEqual(['g:crew']);
    expect((await idp.proveSignup([s.tokenId], { email: 'o@x.test' }))?.emailMatch).toBe(
      'mismatch',
    );
  });

  it('ledgers dry runs as previews, refuses deep claims and honours leases', async () => {
    const idp = createFakeIdp();
    idp.addAccount('u', { class: 'created' });
    await idp.apply('u', { add: ['console'] }, { ...ctx, dryRun: true });
    expect((await idp.calls(0)).filter((c) => c.bucket === 'preview')).toHaveLength(1);
    const deep = { type: 'json', value: { a: { b: { c: { d: { e: { f: 1 } } } } } } } as const;
    await expect(idp.setClaims({ subject: 'u' }, { passbook_d: deep }, ctx)).rejects.toThrow(
      /^IDP_REFUSED/,
    );
    idp.holdLease('s:u');
    await expect(idp.apply('u', { add: ['console'] }, ctx)).rejects.toThrow(/^IDP_CONFLICT/);
    idp.holdLease('g:crew');
    await idp.createGroup('crew', 'Crew', ctx);
    await expect(idp.deleteGroup('crew', ctx)).rejects.toThrow(/^IDP_CONFLICT/);
  });

  it('answers IDP_NOT_MANAGED when re-enabling an owner-disabled account', async () => {
    const idp = createFakeIdp();
    idp.addAccount('theirs', { class: 'created', disabled: true });
    await expect(idp.setDisabled('theirs', false, ctx)).rejects.toThrow(/^IDP_NOT_MANAGED/);
  });

  it('keeps group claims to passbook_* keys, and manages adopted groups', async () => {
    const idp = createFakeIdp({ claimKeys: ['tier'], adopt: { crew: 'Their Crew' } });
    const text = { type: 'text', value: 'x' } as const;
    await expect(idp.setClaims({ group: 'console' }, { tier: text }, ctx)).rejects.toThrow(
      /^IDP_REFUSED/,
    );
    await idp.setClaims({ group: 'g:crew' }, { passbook_a: text }, ctx);
    expect((await idp.claims({ group: 'g:crew' })).claims).toHaveProperty('passbook_a');
    expect(await idp.updateGroup('g:crew', { friendlyName: 'Crew' }, ctx)).toEqual({
      target: 'g:crew',
    });
    await expect(idp.deleteGroup('crew', ctx)).rejects.toThrow(/^IDP_REFUSED/);
    const acct = createFakeIdp({ claimKeys: ['tier'] });
    acct.addAccount('u', { class: 'linked' });
    await acct.setClaims({ subject: 'u' }, { tier: text }, ctx);
  });

  it('charges budgets per bucket and counts removals toward the breaker', async () => {
    const idp = createFakeIdp({
      budget: { apply_add_system: 1, preview: 1, apply_remove: 5 },
      breaker: 1,
    });
    idp.addAccount('u', { class: 'created' });
    const user: WriteCtx = { ...ctx, actor: { kind: 'user', id: 'admin' } };
    await idp.apply('u', { add: ['console'] }, ctx);
    await expect(idp.apply('u', { add: ['developer'] }, ctx)).rejects.toThrow(/^IDP_BUDGET/);
    await idp.apply('u', { add: ['developer'] }, user);
    await idp.apply('u', { add: ['support'] }, { ...user, dryRun: true });
    await expect(idp.apply('u', { add: ['support'] }, { ...user, dryRun: true })).rejects.toThrow(
      /^IDP_BUDGET/,
    );
    await idp.apply('u', { remove: ['console'] }, user);
    await expect(idp.apply('u', { remove: ['developer'] }, user)).rejects.toThrow(/^IDP_BREAKER/);
  });

  it('blocks a renamed or gone group on its own, and settles half-finished deletes', async () => {
    const idp = createFakeIdp();
    idp.addAccount('u', { class: 'created' });
    await idp.createGroup('ga', 'Group A', ctx);
    await idp.createGroup('gb', 'Group B', ctx);
    await idp.createGroup('gc', 'Group C', ctx);
    idp.setGroupState('ga', { renamed: true });
    idp.setGroupState('gb', { state: 'gone' });
    expect((await idp.health()).blocked).toEqual(['g:ga', 'g:gb']);
    for (const t of ['g:ga', 'g:gb'] as const)
      await expect(idp.apply('u', { add: [t] }, ctx)).rejects.toThrow(/^IDP_REFUSED/);
    await expect(idp.setClaims({ group: 'g:ga' }, {}, ctx)).rejects.toThrow();
    await idp.apply('u', { add: ['g:gc'] }, ctx);
    idp.setGroupState('gc', { state: 'deleting' });
    await idp.createGroup('gd', 'Group D', ctx);
    idp.setGroupState('gd', { state: 'deleting' });
    await expect(idp.apply('u', { add: ['g:gd'] }, ctx)).rejects.toThrow(/^IDP_REFUSED/);
    await expect(idp.deleteGroup('gc', ctx)).rejects.toThrow(/^IDP_IN_USE/);
    expect((await idp.groups()).find((g) => g.key === 'gc')?.flags).toEqual([]);
    expect(await idp.deleteGroup('gd', ctx)).toEqual({ key: 'gd' });
  });

  it('does not own accounts in adopted groups, and counts claim sizes in bytes', async () => {
    const idp = createFakeIdp({ adopt: { crew: 'Their Crew' } });
    idp.addAccount('u', { class: 'created', roles: ['g:crew'] });
    await expect(idp.setDisabled('u', true, ctx)).rejects.toThrow(/^IDP_NOT_MANAGED/);
    idp.addAccount('v', { class: 'created' });
    const wide = { type: 'text', value: '\u00e9'.repeat(1100) } as const;
    await expect(idp.setClaims({ subject: 'v' }, { passbook_w: wide }, ctx)).rejects.toThrow(
      /^IDP_REFUSED/,
    );
  });
});
