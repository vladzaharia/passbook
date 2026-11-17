import { beforeAll, describe, expect, it, vi } from 'vitest';
import { asLegacyAuthTokens, deviceToken, makeOrg } from '../../../../test/helpers/index.ts';
import { tokenMac, tokenMatches } from '../../platform/capability-token.ts';
import { first, run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { type Kit, setupKit } from './pass-test-fixtures.ts';
import type { Pass } from './repo.ts';
import { softDeletePass } from './repo.ts';
import { getPass } from './repo-read-pass.ts';
import { updatePass } from './service.ts';
import { sealCapabilityTokens } from './token-seal.ts';

let kit: Kit;
const job = () => jobCtxOf(kit);
beforeAll(async () => {
  kit = await setupKit();
});

async function sweep(ctx = job()) {
  await sealCapabilityTokens(ctx);
  await sealCapabilityTokens(ctx);
}

const seals = (id: string) =>
  first<{ auth: number; link: number }>(
    kit.env.DB,
    `SELECT (SELECT count(*) FROM pass_auth_seals WHERE pass_id = ?) AS auth,
            (SELECT count(*) FROM pass_token_seals WHERE pass_id = ?) AS link`,
    [id, id],
  );
const column = (id: string) =>
  first<{ auth_token: string }>(kit.env.DB, 'SELECT auth_token FROM passes WHERE id = ?', [id]);

async function makeLegacy(pass: Pass, plain: string) {
  await run(kit.env.DB, 'DELETE FROM pass_auth_seals WHERE pass_id = ?', [pass.id]);
  await asLegacyAuthTokens(kit.env.DB, () =>
    run(kit.env.DB, 'UPDATE passes SET auth_token = ? WHERE id = ?', [plain, pass.id]),
  );
}

describe('device token timing', () => {
  it('computes the MAC of the presented token for a sealed, a plain and an unknown row alike', async () => {
    const sign = vi.spyOn(crypto.subtle, 'sign');
    try {
      const mac = await tokenMac(kit.env, 'apple-auth', 'device-token-0123456789');
      for (const stored of [mac, 'device-token-0123456789', `h1:${'0'.repeat(64)}`]) {
        sign.mockClear();
        await tokenMatches(kit.env, 'apple-auth', stored, 'device-token-0123456789');
        expect(sign.mock.calls.filter(([algorithm]) => algorithm === 'HMAC')).toHaveLength(1);
      }
    } finally {
      sign.mockRestore();
    }
  });
});

describe('backfill failures', () => {
  it('logs a failing row, counts it refused and still seals the rows behind it', async () => {
    const [bad, good] = (await Promise.all([kit.pass(), kit.pass()])).sort((a, b) =>
      a.id < b.id ? -1 : 1,
    ) as [Pass, Pass];
    await makeLegacy(bad, `legacy-bad-${bad.id}-${'a'.repeat(16)}`);
    await makeLegacy(good, `legacy-good-${good.id}-${'b'.repeat(16)}`);
    await run(
      kit.env.DB,
      `CREATE TRIGGER auth_seal_boom BEFORE UPDATE OF auth_token ON passes
       WHEN OLD.id = '${bad.id}' BEGIN SELECT RAISE(ABORT, 'boom'); END`,
    );
    const ctx = job();
    const error = vi.spyOn(ctx.log, 'error');
    try {
      await sealCapabilityTokens(ctx);
    } finally {
      await run(kit.env.DB, 'DROP TRIGGER auth_seal_boom');
    }
    expect(error).toHaveBeenCalledWith(
      'tokens.seal_failed',
      expect.objectContaining({ code: 'TOKEN_SEAL_FAILED', purpose: 'apple-auth', id: bad.id }),
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain('legacy-bad');
    expect((await column(good.id))?.auth_token.startsWith('h1:')).toBe(true);
    expect((await column(bad.id))?.auth_token.startsWith('legacy-bad')).toBe(true);
    await sweep(ctx);
    expect((await column(bad.id))?.auth_token.startsWith('h1:')).toBe(true);
  });
});

describe('deleted passes and orgs keep no sealed copy', () => {
  it('drops the sealed copies at the soft delete', async () => {
    const pass = await kit.pass();
    expect(await seals(pass.id)).toEqual({ auth: 1, link: 1 });
    const row = await getPass(kit.env.DB, pass.id);
    if (!row) throw new Error('missing');
    expect(await softDeletePass(kit.env.DB, row, kit.clock.now())).toBe(true);
    expect(await seals(pass.id)).toEqual({ auth: 0, link: 0 });
    expect(await column(pass.id)).toEqual({ auth_token: row.authToken });
  });

  it('seals the MAC only for a pass deleted before the backfill, and for a deleted org', async () => {
    const gone = await kit.pass();
    const legacy = `legacy-gone-${gone.id}-${'c'.repeat(16)}`;
    await makeLegacy(gone, legacy);
    await run(kit.env.DB, 'UPDATE passes SET deleted_at = ? WHERE id = ?', [
      kit.clock.now(),
      gone.id,
    ]);
    const org = await makeOrg(kit.fx, { name: 'Deleted Seal Org' });
    const inOrg = await kit.pass({ orgId: org.id });
    const inOrgLegacy = `legacy-org-${inOrg.id}-${'d'.repeat(16)}`;
    await makeLegacy(inOrg, inOrgLegacy);
    await run(kit.env.DB, 'DELETE FROM pass_token_seals WHERE pass_id = ?', [inOrg.id]);
    await run(kit.env.DB, "UPDATE orgs SET status = 'deleted' WHERE id = ?", [org.id]);
    await sweep();
    expect((await column(gone.id))?.auth_token).toBe(await tokenMac(kit.env, 'apple-auth', legacy));
    expect((await seals(gone.id))?.auth).toBe(0);
    expect((await column(inOrg.id))?.auth_token).toBe(
      await tokenMac(kit.env, 'apple-auth', inOrgLegacy),
    );
    expect((await seals(inOrg.id))?.auth).toBe(0);
  });
});

describe('build without a readable device token', () => {
  it('answers an internal credential error, not link copy', async () => {
    const pass = await kit.pass();
    expect(deviceToken(pass)).toBeTruthy();
    await run(kit.env.DB, 'DELETE FROM pass_auth_seals WHERE pass_id = ?', [pass.id]);
    await expect(
      updatePass(
        job(),
        { type: 'system', id: null },
        pass.id,
        { input: { memberName: 'No seal' } },
        { scope: null },
      ),
    ).rejects.toMatchObject({ code: 'DEVICE_TOKEN_UNAVAILABLE', status: 500 });
  });
});

describe('case-sensitive MAC guard', () => {
  it('refuses an upper-case prefix', async () => {
    const pass = await kit.pass();
    await expect(
      run(kit.env.DB, "UPDATE passes SET auth_token = 'H1:abc' WHERE id = ?", [pass.id]),
    ).rejects.toThrow(/auth_token must be a MAC/);
  });
});
