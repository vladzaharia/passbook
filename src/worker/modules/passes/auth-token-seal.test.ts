import { unzipSync } from 'fflate';
import { beforeAll, describe, expect, it } from 'vitest';
import { authTokenOf, deviceToken } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { isTokenMac, tokenMac, tokenMatches } from '../../platform/capability-token.ts';
import { first, run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { type Kit, setupKit } from './pass-test-fixtures.ts';
import { updatePass } from './service.ts';

const TYPE = 'pass.im.plrs.wallet';
let kit: Kit;
const job = () => jobCtxOf(kit);

beforeAll(async () => {
  kit = await setupKit();
});

const latest = (serial: string, token: string) =>
  createApp({ clock: kit.clock }).request(
    `https://wallet.test/wallet/v1/passes/${TYPE}/${serial}`,
    { headers: { authorization: `ApplePass ${token}` } },
    kit.env,
  );

describe('device token at rest', () => {
  it('stores a MAC with a sealed copy and builds the plain token into pass.json', async () => {
    const pass = await kit.pass();
    const plain = deviceToken(pass);
    expect(isTokenMac(pass.authToken)).toBe(true);
    expect(isTokenMac(plain)).toBe(false);
    expect(pass.authToken).toBe(await tokenMac(kit.env, 'apple-auth', plain));
    expect(await authTokenOf(kit.env, pass)).toBe(plain);
    const seal = await first(kit.env.DB, 'SELECT 1 AS ok FROM pass_auth_seals WHERE pass_id = ?', [
      pass.id,
    ]);
    expect(seal).toEqual({ ok: 1 });

    const files = unzipSync(new Uint8Array(await (await latest(pass.serial, plain)).arrayBuffer()));
    const built = JSON.parse(new TextDecoder().decode(files['pass.json']));
    expect(built.authenticationToken).toBe(plain);
    const stored = await first<{ pass_json: string }>(
      kit.env.DB,
      'SELECT pass_json FROM pass_versions WHERE pass_id = ? ORDER BY version DESC LIMIT 1',
      [pass.id],
    );
    expect(stored?.pass_json).toBeTruthy();
    expect(stored?.pass_json).not.toContain('authenticationToken');
    expect(stored?.pass_json).not.toContain(plain);
  });

  it('keeps the token in every republished pass.json and out of every stored copy', async () => {
    const pass = await kit.pass();
    const plain = deviceToken(pass);
    await updatePass(
      job(),
      { type: 'system', id: null },
      pass.id,
      { input: { memberName: 'Edited' } },
      { scope: null },
    );
    const files = unzipSync(new Uint8Array(await (await latest(pass.serial, plain)).arrayBuffer()));
    expect(JSON.parse(new TextDecoder().decode(files['pass.json'])).authenticationToken).toBe(
      plain,
    );
    const leaked = await first(
      kit.env.DB,
      `SELECT 1 AS n FROM pass_versions WHERE pass_id = ? AND pass_json LIKE '%' || ? || '%'`,
      [pass.id, plain],
    );
    expect(leaked).toBeNull();
  });
});

describe('device web service auth by MAC', () => {
  it('accepts the token and refuses a wrong one, the stored MAC, and another pass token', async () => {
    const a = await kit.pass();
    const b = await kit.pass();
    expect((await latest(a.serial, deviceToken(a))).status).toBe(200);
    expect((await latest(a.serial, `${deviceToken(a)}x`)).status).toBe(401);
    expect((await latest(a.serial, a.authToken)).status).toBe(401);
    expect((await latest(a.serial, deviceToken(b))).status).toBe(401);
    expect((await latest(a.serial, '')).status).toBe(401);
    expect((await latest('no-such-serial', deviceToken(a))).status).toBe(401);
    const bare = await createApp({ clock: kit.clock }).request(
      `https://wallet.test/wallet/v1/passes/${TYPE}/${a.serial}`,
      { headers: { authorization: deviceToken(a) } },
      kit.env,
    );
    expect(bare.status).toBe(401);
  });

  it('compares the MAC of the presented value, so a MAC and another purpose never match', async () => {
    const mac = await tokenMac(kit.env, 'apple-auth', 'device-token-0123456789');
    expect(await tokenMatches(kit.env, 'apple-auth', mac, 'device-token-0123456789')).toBe(true);
    expect(await tokenMatches(kit.env, 'apple-auth', mac, 'device-token-0123456780')).toBe(false);
    expect(await tokenMatches(kit.env, 'apple-auth', mac, mac)).toBe(false);
    expect(await tokenMac(kit.env, 'pass', 'device-token-0123456789')).not.toBe(mac);
    expect(await tokenMatches(kit.env, 'apple-auth', 'plain-value', 'plain-value')).toBe(false);
  });
});

describe('device token guards', () => {
  it('refuses a plain value, a change outside a transfer, and a stored pass.json with the token', async () => {
    const pass = await kit.pass();
    await expect(
      run(kit.env.DB, "UPDATE passes SET auth_token = 'plain' WHERE id = ?", [pass.id]),
    ).rejects.toThrow(/auth_token must be a MAC|credential transfer required/);
    await expect(
      run(kit.env.DB, "UPDATE passes SET auth_token = 'h1:other' WHERE id = ?", [pass.id]),
    ).rejects.toThrow(/credential transfer required|credential generation bump/);
    await expect(
      run(
        kit.env.DB,
        `INSERT INTO passes (id, org_id, identity_id, serial, template_id, template_version, auth_token,
           download_token, web_service_url, object_key, modified_at, created_at, pending_cause)
         SELECT 'plain-insert', org_id, identity_id, 'plain-serial', template_id, template_version, 'plain',
           'h1:dl-plain', web_service_url, object_key, modified_at, created_at, 'create' FROM passes WHERE id = ?`,
        [pass.id],
      ),
    ).rejects.toThrow(/auth_token must be a MAC/);
    await expect(
      run(
        kit.env.DB,
        `UPDATE pass_versions SET pass_json = json_set(pass_json, '$.authenticationToken', 'x') WHERE pass_id = ?`,
        [pass.id],
      ),
    ).rejects.toThrow(/must not carry the authenticationToken/);
  });
});
