import { beforeEach, describe, expect, it } from 'vitest';
import { captureLogs, ctx, dumpAll, ledger, resetLedger, setup } from './harness.ts';

beforeEach(resetLedger);

describe.each(['v2', 'admin'] as const)('findByVerifiedEmail (%s layout)', (layout) => {
  const base = layout === 'admin' ? '/api/admin' : '/api';

  it('returns only the subject of the one enabled, verified, non-admin account', async () => {
    const { api, pocket } = setup(layout);
    pocket.addUser('u1', { email: 'Ada@Example.test' });
    pocket.addUser('u2', { email: 'ada.other@example.test' });
    const found = await api.findByVerifiedEmail('ada@example.test', ctx());
    expect(found).toEqual({ subject: 'u1' });
    expect(Object.keys(found as object)).toEqual(['subject']);
    expect(pocket.s.seen[0]).toMatchObject({
      method: 'GET',
      path: `${base}/users?search=ada%40example.test&pagination[limit]=100&pagination[page]=1`,
    });
    expect(pocket.writes()).toHaveLength(0);
  });

  it.each([
    ['not verified', { emailVerified: false }],
    ['disabled', { disabled: true }],
    ['an admin', { isAdmin: true }],
    ['in a protected group', { groups: ['g-admins'] }],
  ])('answers null for an account that is %s', async (_n, o) => {
    const { api, pocket } = setup(layout);
    pocket.addUser('u1', { email: 'a@example.test', ...o });
    await expect(api.findByVerifiedEmail('a@example.test', ctx())).resolves.toBeNull();
  });

  it('answers null for no match, and for two accounts with the address', async () => {
    const { api, pocket } = setup(layout);
    await expect(api.findByVerifiedEmail('nobody@example.test', ctx())).resolves.toBeNull();
    pocket.addUser('u1', { email: 'dup@example.test' });
    pocket.addUser('u2', { email: 'DUP@example.test' });
    await expect(api.findByVerifiedEmail('dup@example.test', ctx())).resolves.toBeNull();
  });

  it('counts an ineligible twin: one verified and one unverified account is no match', async () => {
    const { api, pocket } = setup(layout);
    pocket.addUser('u1', { email: 'dup@example.test' });
    pocket.addUser('u2', { email: 'dup@example.test', emailVerified: false });
    await expect(api.findByVerifiedEmail('dup@example.test', ctx())).resolves.toBeNull();
  });

  it.each(['emailVerified', 'disabled', 'isAdmin', 'userGroups'])(
    'answers null when the DTO lacks %s',
    async (field) => {
      const { api, pocket } = setup(layout);
      pocket.addUser('u1', { email: 'a@example.test' });
      pocket.s.userDto = (dto) => {
        const { [field]: _gone, ...rest } = dto;
        return rest;
      };
      await expect(api.findByVerifiedEmail('a@example.test', ctx())).resolves.toBeNull();
    },
  );

  it.each([
    '',
    'not an email',
    'a@b',
    'a..b@example.test',
    `${'a'.repeat(250)}@x.test`,
    'a b@example.test',
  ])('refuses %j without a call', async (email) => {
    const { api, pocket } = setup(layout);
    await expect(api.findByVerifiedEmail(email, ctx())).rejects.toThrow(/^IDP_REFUSED/);
    expect(pocket.s.seen).toHaveLength(0);
  });

  it('keeps the address out of the ledger, the tables and the logs', async () => {
    const { api, pocket } = setup(layout);
    pocket.addUser('u1', { email: 'private.person@example.test' });
    const logs = await captureLogs(() =>
      api.findByVerifiedEmail('private.person@example.test', ctx()),
    );
    const everything = [
      ...logs.lines,
      JSON.stringify(await ledger()),
      await dumpAll(),
      JSON.stringify(logs.result),
    ];
    for (const text of everything) expect(text).not.toContain('private.person');
  });
});
