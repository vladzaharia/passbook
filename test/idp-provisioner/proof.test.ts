import { beforeEach, describe, expect, it } from 'vitest';
import { captureLogs, dumpAll, NOW, resetLedger, rows, setup } from './harness.ts';

beforeEach(resetLedger);

describe.each(['v2', 'admin'] as const)('signup proof (%s layout)', (layout) => {
  async function minted(n = 1) {
    const s = setup(layout);
    const out = [];
    for (let i = 0; i < n; i++) out.push(await s.api.createSignup(`inv-${i}`));
    return { ...s, tokens: out };
  }

  it('mints the fixed token, stores a hash and the id, and returns the link once', async () => {
    const { tokens, pocket } = await minted();
    expect(tokens[0]).toMatchObject({ tokenId: 'tok-id-1', expiresAt: NOW + 3_600_000 });
    expect(tokens[0]?.url).toBe('https://id.test/st/SECRETTOKEN1abcdef');
    const dump = await dumpAll();
    expect(dump).not.toContain('SECRETTOKEN');
    expect(dump).not.toContain('/st/');
    const [row] = await rows('idp_signups');
    expect(row).toMatchObject({
      token_id: 'tok-id-1',
      ref: 'inv-0',
      state: 'minted',
      subject: null,
    });
    expect(String(row?.token_sha256)).toMatch(/^[0-9a-f]{64}$/);
    expect(pocket.writes()).toHaveLength(1);
  });

  it('proves the account a token created, matching the v2 hash or the admin id', async () => {
    const { api, pocket, tokens } = await minted();
    pocket.signUp('tok-id-1', 'u-new');
    await expect(api.proveSignup([tokens[0]?.tokenId as string], 'u-new')).resolves.toMatchObject({
      tokenId: 'tok-id-1',
      subject: 'u-new',
    });
    expect(await rows('idp_grants')).toMatchObject([
      { subject: 'u-new', source: 'signup', token_id: 'tok-id-1', removed_at: null },
    ]);
    expect(await rows('idp_signups')).toMatchObject([{ state: 'proven', subject: 'u-new' }]);
    const audit = JSON.stringify(pocket.s.audit);
    expect(audit).toContain(layout === 'admin' ? 'signupTokenID' : 'signupToken"');
  });

  it('is idempotent and answers the same subject again without a call', async () => {
    const { api, pocket } = await minted();
    pocket.signUp('tok-id-1', 'u-new');
    await api.proveSignup(['tok-id-1'], 'u-new');
    const calls = pocket.s.seen.length;
    await expect(api.proveSignup(['tok-id-1'], 'u-new')).resolves.toMatchObject({
      subject: 'u-new',
    });
    await expect(api.proveSignup(['tok-id-1'])).resolves.toMatchObject({ subject: 'u-new' });
    expect(pocket.s.seen).toHaveLength(calls);
  });

  it('answers null when the signed-in account is not the one the token created', async () => {
    const { api, pocket } = await minted();
    pocket.signUp('tok-id-1', 'u-new');
    await expect(api.proveSignup(['tok-id-1'], 'someone-else')).resolves.toBeNull();
    expect(await rows('idp_grants')).toHaveLength(0);
  });

  it('refuses a token already proven for another subject', async () => {
    const { api, pocket } = await minted();
    pocket.signUp('tok-id-1', 'u-new');
    await api.proveSignup(['tok-id-1'], 'u-new');
    await expect(api.proveSignup(['tok-id-1'], 'someone-else')).rejects.toThrow(/^IDP_REFUSED/);
  });

  it('allows one subject per token: two accounts on one token match none', async () => {
    const { api, pocket } = await minted();
    pocket.signUp('tok-id-1', 'u-a');
    pocket.signUp('tok-id-1', 'u-b');
    const logs = await captureLogs(() => api.proveSignup(['tok-id-1']));
    expect(logs.result).toBeNull();
    expect(logs.lines.some((l) => l.includes('provisioner.proof_ambiguous'))).toBe(true);
    expect(await rows('idp_grants')).toHaveLength(0);
  });

  it('allows one token per subject', async () => {
    const { api, pocket } = await minted(2);
    pocket.signUp('tok-id-1', 'u-a');
    pocket.signUp('tok-id-2', 'u-a');
    await expect(api.proveSignup(['tok-id-1', 'tok-id-2'])).rejects.toThrow(/^IDP_CONFLICT/);
  });

  it('records every account in a sweep and returns them all', async () => {
    const { api, pocket } = await minted(2);
    pocket.signUp('tok-id-1', 'u-a');
    pocket.signUp('tok-id-2', 'u-b');
    const proof = await api.proveSignup(['tok-id-1', 'tok-id-2']);
    expect(proof?.matches.map((m) => m.subject).sort()).toEqual(['u-a', 'u-b']);
    expect(await rows('idp_grants')).toHaveLength(2);
  });

  it('answers null for a token nobody used', async () => {
    const { api } = await minted();
    await expect(api.proveSignup(['tok-id-1'])).resolves.toBeNull();
  });

  it('ignores account creations outside the token life', async () => {
    const { api, pocket } = await minted(2);
    pocket.signUp('tok-id-1', 'u-early', NOW - 10 * 60_000);
    pocket.signUp('tok-id-2', 'u-late', NOW + 3_600_000 + 10 * 60_000);
    await expect(api.proveSignup(['tok-id-1', 'tok-id-2'])).resolves.toBeNull();
  });

  it('does not match another token or another value', async () => {
    const { api, pocket } = await minted(2);
    pocket.signUp('tok-id-2', 'u-b');
    const proof = await api.proveSignup(['tok-id-1']);
    expect(proof).toBeNull();
    await expect(api.proveSignup(['tok-id-2'], 'u-b')).resolves.toMatchObject({
      tokenId: 'tok-id-2',
    });
  });

  it('refuses tokens it did not mint, and bad input, without a call', async () => {
    const { api, pocket } = await minted();
    const calls = pocket.s.seen.length;
    await expect(api.proveSignup(['foreign'])).rejects.toThrow(/^IDP_REFUSED/);
    await expect(api.proveSignup([])).rejects.toThrow(/^IDP_REFUSED/);
    await expect(api.proveSignup(['a/b'])).rejects.toThrow(/^IDP_REFUSED/);
    await expect(api.deleteSignup('foreign')).rejects.toThrow(/^IDP_REFUSED/);
    expect(pocket.s.seen).toHaveLength(calls);
  });

  it('withdraws a token that does not carry exactly the developers group', async () => {
    const { api, pocket } = setup(layout);
    pocket.s.tokenGroups = ['g-dev', 'g-admins'];
    const logs = await captureLogs(() => api.createSignup('inv-1'));
    expect(String(logs.error)).toMatch(/^Error: IDP_DRIFT/);
    expect(pocket.s.tokens).toHaveLength(0);
    expect(await rows('idp_signups')).toHaveLength(0);
  });

  it('deletes an unused token once, reports a used one, and reads gone for a missing one', async () => {
    const { api, pocket } = await minted(3);
    await expect(api.deleteSignup('tok-id-1')).resolves.toBe('deleted');
    expect(pocket.s.tokens.map((t) => t.id)).toEqual(['tok-id-2', 'tok-id-3']);
    const calls = pocket.s.seen.length;
    await expect(api.deleteSignup('tok-id-1')).resolves.toBe('gone');
    expect(pocket.s.seen).toHaveLength(calls);

    pocket.signUp('tok-id-2', 'u-b');
    await expect(api.deleteSignup('tok-id-2')).resolves.toBe('used');
    expect(pocket.s.tokens.map((t) => t.id)).toContain('tok-id-2');

    pocket.s.tokens.splice(0, pocket.s.tokens.length);
    await expect(api.deleteSignup('tok-id-3')).resolves.toBe('gone');
    expect(await rows('idp_signups')).toMatchObject([
      { state: 'deleted' },
      { state: 'used' },
      { state: 'deleted' },
    ]);
  });

  it('can still prove an account from a token that was deleted after use', async () => {
    const { api, pocket } = await minted();
    pocket.signUp('tok-id-1', 'u-a');
    await expect(api.deleteSignup('tok-id-1')).resolves.toBe('used');
    await expect(api.proveSignup(['tok-id-1'])).resolves.toMatchObject({ subject: 'u-a' });
  });

  it('removes the group from an account its token created, and from no other', async () => {
    const { api, pocket } = await minted();
    pocket.signUp('tok-id-1', 'u-new');
    pocket.addUser('u-manual', { groups: ['g-dev'] });
    await api.proveSignup(['tok-id-1'], 'u-new');
    await expect(api.removeDeveloper('u-new', 'ended')).resolves.toBe('removed');
    expect(pocket.s.users.get('u-new')?.groups).toEqual([]);
    await expect(api.removeDeveloper('u-manual', 'ended')).resolves.toBe('not_ours');
    expect(pocket.s.users.get('u-manual')?.groups).toEqual(['g-dev']);
  });
});
