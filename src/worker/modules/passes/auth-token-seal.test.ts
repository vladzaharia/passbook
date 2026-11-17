import { unzipSync } from 'fflate';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  asLegacyAuthTokens,
  authTokenOf,
  deviceToken,
  makeOrg,
  withoutTrigger,
} from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import {
  isTokenMac,
  revealToken,
  tokenMac,
  tokenMatches,
} from '../../platform/capability-token.ts';
import { all, first, run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { type Kit, setupKit } from './pass-test-fixtures.ts';
import type { Pass } from './repo.ts';
import { getPass } from './repo-read-pass.ts';
import { updatePass } from './service.ts';
import { sealCapabilityTokens } from './token-seal.ts';

const TYPE = 'pass.im.plrs.wallet';
let kit: Kit;
const job = () => jobCtxOf(kit);

beforeAll(async () => {
  kit = await setupKit();
});

/** Two runs: ids made in the same millisecond may sort behind the cursor, and a run at the end rewinds it. */
async function sweep() {
  await sealCapabilityTokens(job());
  await sealCapabilityTokens(job());
}

const latest = (serial: string, token: string) =>
  createApp({ clock: kit.clock }).request(
    `https://wallet.test/wallet/v1/passes/${TYPE}/${serial}`,
    { headers: { authorization: `ApplePass ${token}` } },
    kit.env,
  );

const column = (id: string) =>
  first<{ auth_token: string; row_version: number; credential_generation: number }>(
    kit.env.DB,
    'SELECT auth_token, row_version, credential_generation FROM passes WHERE id = ?',
    [id],
  );

/** A pass as it was before 0065: the plain device token in the column, no sealed copy. */
async function makeLegacy(pass: Pass, plain: string) {
  await run(kit.env.DB, 'DELETE FROM pass_auth_seals WHERE pass_id = ?', [pass.id]);
  await asLegacyAuthTokens(kit.env.DB, () =>
    run(kit.env.DB, 'UPDATE passes SET auth_token = ? WHERE id = ?', [plain, pass.id]),
  );
}

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
    expect(await tokenMatches(kit.env, 'apple-auth', 'plain-value', 'plain-value')).toBe(true);
    expect(await tokenMatches(kit.env, 'apple-auth', 'plain-value', 'plain-valuf')).toBe(false);
  });

  it('serves a row the backfill has not reached, then the same token after it', async () => {
    const pass = await kit.pass();
    const legacy = `legacy-device-${pass.id}-${'x'.repeat(16)}`;
    await makeLegacy(pass, legacy);
    expect((await latest(pass.serial, legacy)).status).toBe(200);
    expect((await latest(pass.serial, pass.authToken)).status).toBe(401);
    await sweep();
    expect((await column(pass.id))?.auth_token).toBe(await tokenMac(kit.env, 'apple-auth', legacy));
    expect((await latest(pass.serial, legacy)).status).toBe(200);
  });
});

describe('sealing legacy device tokens', () => {
  it('seals, keeps pass.json and row_version, and never bumps the pass', async () => {
    const pass = await kit.pass();
    const legacy = `legacy-seal-${pass.id}-${'y'.repeat(16)}`;
    await makeLegacy(pass, legacy);
    const before = await column(pass.id);
    await sweep();
    const after = await column(pass.id);
    expect(isTokenMac(after?.auth_token ?? '')).toBe(true);
    expect(after?.row_version).toBe(before?.row_version);
    expect(after?.credential_generation).toBe(before?.credential_generation);
    const row = await getPass(kit.env.DB, pass.id);
    expect(
      row && (await revealToken(kit.env, 'apple-auth', row.id, row.orgId, row.authToken)),
    ).toBe(legacy);
    await updatePass(
      job(),
      { type: 'system', id: null },
      pass.id,
      { input: { memberName: 'After seal' } },
      { scope: null },
    );
    const files = unzipSync(
      new Uint8Array(await (await latest(pass.serial, legacy)).arrayBuffer()),
    );
    expect(JSON.parse(new TextDecoder().decode(files['pass.json'])).authenticationToken).toBe(
      legacy,
    );
  });

  it('skips a pass with a pending credential transfer', async () => {
    const pass = await kit.pass();
    const legacy = `legacy-pending-${pass.id}-${'z'.repeat(16)}`;
    await makeLegacy(pass, legacy);
    await run(
      kit.env.DB,
      `INSERT INTO pass_credential_transfers
        (id, pass_id, org_id, mode, state, source_generation, source_version, source_revision, source_row_version,
         source_lifecycle_generation, source_link_generation, requested_by_type, requested_at)
       SELECT ?, p.id, p.org_id, p.mode, 'pending', p.credential_generation, p.version, p.revision, p.row_version,
         p.lifecycle_generation, p.link_generation + 1, 'system', ? FROM passes p WHERE p.id = ?`,
      [kit.fx.ids.id(), kit.clock.now(), pass.id],
    );
    await sweep();
    expect((await column(pass.id))?.auth_token).toBe(legacy);
  });

  it('seals a pass of a suspended org by the trusted write', async () => {
    const org = await makeOrg(kit.fx, { name: 'Suspended Device Org' });
    const pass = await kit.pass({ orgId: org.id });
    const legacy = `legacy-suspended-${pass.id}-${'w'.repeat(16)}`;
    await makeLegacy(pass, legacy);
    await run(kit.env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [org.id]);
    const before = await column(pass.id);
    await sweep();
    const after = await column(pass.id);
    expect(after?.auth_token).toBe(await tokenMac(kit.env, 'apple-auth', legacy));
    expect(after?.row_version).toBe(before?.row_version);
    const row = await getPass(kit.env.DB, pass.id);
    expect(
      row && (await revealToken(kit.env, 'apple-auth', row.id, row.orgId, row.authToken)),
    ).toBe(legacy);
  });

  it('removes the device token from stored pass.json copies written before 0065', async () => {
    const pass = await kit.pass();
    const plain = deviceToken(pass);
    await withoutTrigger(kit.env.DB, 'pass_versions_no_auth_token_update', () =>
      run(
        kit.env.DB,
        `UPDATE pass_versions SET pass_json = json_set(pass_json, '$.authenticationToken', ?) WHERE pass_id = ?`,
        [plain, pass.id],
      ),
    );
    const has = () =>
      first(
        kit.env.DB,
        `SELECT 1 AS n FROM pass_versions WHERE pass_id = ? AND pass_json LIKE '%' || ? || '%'`,
        [pass.id, plain],
      );
    expect(await has()).toEqual({ n: 1 });
    await sweep();
    expect(await has()).toBeNull();
    const kept = await first<{ pass_json: string }>(
      kit.env.DB,
      'SELECT pass_json FROM pass_versions WHERE pass_id = ?',
      [pass.id],
    );
    expect(JSON.parse(kept?.pass_json ?? '{}').serialNumber).toBe(pass.serial);
  });
});

describe('device token guards', () => {
  it('refuses a plain value, a change outside a transfer, and a stored pass.json with the token', async () => {
    const pass = await kit.pass();
    await expect(
      run(kit.env.DB, "UPDATE passes SET auth_token = 'plain' WHERE id = ?", [pass.id]),
    ).rejects.toThrow(/auth_token must be a MAC/);
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

describe('backfill work lists', () => {
  it('are walked by their partial indexes', async () => {
    const plan = async (sql: string) =>
      (await all<{ detail: string }>(kit.env.DB, `EXPLAIN QUERY PLAN ${sql}`))
        .map((row) => row.detail)
        .join('\n');
    expect(
      await plan(
        "SELECT id FROM passes WHERE auth_token NOT LIKE 'h1:%' AND id > 'a' ORDER BY id LIMIT 5",
      ),
    ).toContain('passes_auth_plain');
    expect(
      await plan(`SELECT pass_id, version FROM pass_versions
        WHERE CASE WHEN json_valid(pass_json) THEN json_type(pass_json, '$.authenticationToken') END IS NOT NULL LIMIT 5`),
    ).toContain('pass_versions_auth_plain');
  });
});
