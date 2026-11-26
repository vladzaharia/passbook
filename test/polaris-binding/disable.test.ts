import { beforeEach, describe, expect, it } from 'vitest';
import { PUT_FIELDS } from '../../workers/polaris-binding/src/user-put.ts';
import { ctx, ledger, resetLedger, rows, seedCreated, seedGrant, setup } from './harness.ts';

beforeEach(resetLedger);

describe.each(['v2', 'admin'] as const)('setDisabled (%s layout)', (layout) => {
  const base = layout === 'admin' ? '/api/admin' : '/api';

  async function created(opts: { groups?: string[] } = {}) {
    const s = setup(layout);
    s.pocket.addUser('u1', {
      groups: opts.groups ?? ['g-dev'],
      firstName: 'Ada',
      lastName: 'Lovelace',
      displayName: 'Ada L',
      locale: 'en',
      email: 'ada@example.test',
    });
    await seedCreated('u1');
    return s;
  }

  it('echoes every field of a fresh read except disabled, then reads back and compares', async () => {
    const { api, pocket } = await created();
    await expect(api.setDisabled('u1', true, ctx())).resolves.toEqual({
      result: 'disabled',
      dryRun: false,
    });
    const put = pocket.writes().find((w) => w.method === 'PUT');
    expect(put?.path).toBe(`${base}/users/u1`);
    expect(put?.body).toEqual({
      username: 'u-u1',
      email: 'ada@example.test',
      emailVerified: true,
      firstName: 'Ada',
      lastName: 'Lovelace',
      displayName: 'Ada L',
      isAdmin: false,
      locale: 'en',
      disabled: true,
    });
    expect(Object.keys(put?.body as object).sort()).toEqual([...PUT_FIELDS].sort());
    expect(pocket.s.seen.at(-1)).toMatchObject({ method: 'GET', path: `${base}/users/u1` });
    expect(pocket.s.users.get('u1')).toMatchObject({
      disabled: true,
      firstName: 'Ada',
      locale: 'en',
    });
    expect(await rows('idp_subjects')).toMatchObject([
      { subject: 'u1', disabled_by_binding_at: expect.any(Number) },
    ]);
  });

  it('enables only what the binding disabled', async () => {
    const { api, pocket } = await created();
    await api.setDisabled('u1', true, ctx());
    await expect(api.setDisabled('u1', false, ctx())).resolves.toEqual({
      result: 'enabled',
      dryRun: false,
    });
    expect(pocket.s.users.get('u1')?.disabled).toBe(false);
    expect((await rows('idp_subjects'))[0]?.disabled_by_binding_at).toBeNull();
    // the owner disables it by hand: PassBook does not undo that
    pocket.s.users.get('u1')!.disabled = true;
    await expect(api.setDisabled('u1', false, ctx())).rejects.toThrow(/^IDP_NOT_MANAGED/);
    expect(pocket.s.users.get('u1')?.disabled).toBe(true);
  });

  it('answers already without a write', async () => {
    const { api, pocket } = await created();
    await expect(api.setDisabled('u1', false, ctx())).rejects.toThrow(/^IDP_NOT_MANAGED/);
    pocket.s.users.get('u1')!.disabled = true;
    await api.setDisabled('u1', true, ctx());
    expect(pocket.writes()).toHaveLength(0);
  });

  it('refuses a partial read: any missing field means no write', async () => {
    for (const field of PUT_FIELDS.filter((f) => f !== 'disabled' && f !== 'isAdmin')) {
      await resetLedger();
      const { api, pocket } = await created();
      pocket.s.userDto = (dto) => {
        const { [field]: _gone, ...rest } = dto;
        return rest;
      };
      await expect(api.setDisabled('u1', true, ctx())).rejects.toThrow(/^IDP_UPSTREAM/);
      expect(pocket.writes(), field).toHaveLength(0);
    }
  });

  it('raises drift when the read-back differs in any field, and never retries', async () => {
    for (const field of ['email', 'isAdmin', 'emailVerified', 'displayName']) {
      await resetLedger();
      const { api, pocket } = await created();
      pocket.s.putUserTransform = (body) => ({
        ...body,
        [field]:
          field === 'email'
            ? 'other@example.test'
            : !body[field] && field !== 'displayName'
              ? true
              : 'x',
      });
      await expect(api.setDisabled('u1', true, ctx()), field).rejects.toThrow(/^IDP_DRIFT/);
      expect(pocket.writes().filter((w) => w.method === 'PUT')).toHaveLength(1);
    }
  });

  it('manages created accounts only', async () => {
    const { api, pocket } = setup(layout);
    pocket.addUser('linked', { groups: ['g-dev'] });
    pocket.addUser('ext', { groups: ['g-dev'] });
    await seedGrant('linked');
    await expect(api.setDisabled('linked', true, ctx())).rejects.toThrow(/^IDP_NOT_MANAGED/);
    await expect(api.setDisabled('ext', true, ctx())).rejects.toThrow(/^IDP_NOT_MANAGED/);
    await expect(api.setDisabled('ghost', true, ctx())).rejects.toThrow(/^IDP_NOT_MANAGED/);
    expect(pocket.s.seen.filter((x) => /\/users\/(linked|ext|ghost)/.test(x.path))).toHaveLength(0);
    expect((await ledger()).filter((r) => r.status === 'IDP_NOT_MANAGED')).toHaveLength(3);
  });

  it('refuses an account in a group outside the registry', async () => {
    const { api, pocket } = await created({ groups: ['g-dev', 'g-extra'] });
    await expect(api.setDisabled('u1', true, ctx())).rejects.toThrow(/^IDP_NOT_MANAGED/);
    expect(pocket.writes()).toHaveLength(0);
  });

  it('refuses admins and protected-group members, even when ours', async () => {
    const { api, pocket } = setup(layout);
    pocket.addUser('adm', { isAdmin: true, groups: ['g-dev'] });
    pocket.addUser('pa', { groups: ['g-admins'] });
    await seedCreated('adm');
    await seedCreated('pa');
    await expect(api.setDisabled('adm', true, ctx())).rejects.toThrow(/^IDP_REFUSED/);
    await expect(api.setDisabled('pa', true, ctx())).rejects.toThrow(/^IDP_REFUSED/);
    expect(pocket.writes()).toHaveLength(0);
  });

  it('refuses a non-boolean flag and a bad subject', async () => {
    const { api, pocket } = await created();
    const hostile = api.setDisabled as unknown as (...a: unknown[]) => Promise<unknown>;
    await expect(hostile('u1', 'true', ctx())).rejects.toThrow(/^IDP_REFUSED/);
    await expect(hostile('me', true, ctx())).rejects.toThrow(/^IDP_REFUSED/);
    await expect(hostile('a/b', true, ctx())).rejects.toThrow(/^IDP_REFUSED/);
    expect(pocket.s.seen).toHaveLength(0);
  });
});
