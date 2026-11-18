import { beforeAll, describe, expect, it, vi } from 'vitest';
import { deviceToken } from '../../../../test/helpers/index.ts';
import { tokenMac, tokenMatches } from '../../platform/capability-token.ts';
import { first, run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { type Kit, setupKit } from './pass-test-fixtures.ts';
import { softDeletePass } from './repo.ts';
import { getPass } from './repo-read-pass.ts';
import { updatePass } from './service.ts';

let kit: Kit;
const job = () => jobCtxOf(kit);
beforeAll(async () => {
  kit = await setupKit();
});

const seals = (id: string) =>
  first<{ auth: number; link: number }>(
    kit.env.DB,
    `SELECT (SELECT count(*) FROM pass_auth_seals WHERE pass_id = ?) AS auth,
            (SELECT count(*) FROM pass_token_seals WHERE pass_id = ?) AS link`,
    [id, id],
  );
const column = (id: string) =>
  first<{ auth_token: string }>(kit.env.DB, 'SELECT auth_token FROM passes WHERE id = ?', [id]);

describe('device token timing', () => {
  it('computes the MAC of the presented token for a known and an unknown row alike', async () => {
    const sign = vi.spyOn(crypto.subtle, 'sign');
    try {
      const mac = await tokenMac(kit.env, 'apple-auth', 'device-token-0123456789');
      for (const stored of [mac, `h1:${'0'.repeat(64)}`]) {
        sign.mockClear();
        await tokenMatches(kit.env, 'apple-auth', stored, 'device-token-0123456789');
        expect(sign.mock.calls.filter(([algorithm]) => algorithm === 'HMAC')).toHaveLength(1);
      }
    } finally {
      sign.mockRestore();
    }
  });
});

describe('deleted passes keep no sealed copy', () => {
  it('drops the sealed copies at the soft delete', async () => {
    const pass = await kit.pass();
    expect(await seals(pass.id)).toEqual({ auth: 1, link: 1 });
    const row = await getPass(kit.env.DB, pass.id);
    if (!row) throw new Error('missing');
    expect(await softDeletePass(kit.env.DB, row, kit.clock.now())).toBe(true);
    expect(await seals(pass.id)).toEqual({ auth: 0, link: 0 });
    expect(await column(pass.id)).toEqual({ auth_token: row.authToken });
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
    ).rejects.toThrow(/auth_token must be a MAC|credential transfer required/);
  });
});
