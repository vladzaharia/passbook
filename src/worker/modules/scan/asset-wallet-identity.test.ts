import { beforeAll, describe, expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import { publishPass } from '../passes/publish.ts';
import { genericAssetGrantFor } from './asset-test-fixtures.ts';
import { assetWalletActive } from './assets.ts';
import { candidateById } from './repo-lookup.ts';
import { type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
let template: string;
beforeAll(async () => {
  kit = await setupScanKit();
  template = await kit.scanTemplate('Wallet asset identity', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
  });
});

async function fixture() {
  const scanner = await kit.scanner({ templateIds: [template] });
  const pass = await kit.scanPass(template);
  const grant = await genericAssetGrantFor(kit, scanner, pass.id);
  const image = () => kit.get(scanner.headers, `/passes/${pass.id}/assets/icon.png?g=${grant}`);
  return { scanner, pass, image };
}

async function missing(response: Response) {
  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({ code: 'ASSET_NOT_FOUND' });
}

describe('scanner asset Wallet identity', () => {
  it.each([
    ['missing Wallet JSON', 'UPDATE pass_versions SET pass_json = NULL WHERE pass_id = ?'],
    ['missing Wallet identity', "UPDATE pass_versions SET pass_json = '{}' WHERE pass_id = ?"],
    [
      'wrong serial',
      "UPDATE pass_versions SET pass_json = json_set(pass_json, '$.serialNumber', 'foreign') WHERE pass_id = ?",
    ],
    [
      'wrong pass type',
      "UPDATE pass_versions SET pass_json = json_set(pass_json, '$.passTypeIdentifier', 'pass.foreign') WHERE pass_id = ?",
    ],
    [
      'wrong team',
      "UPDATE pass_versions SET pass_json = json_set(pass_json, '$.teamIdentifier', 'FOREIGN') WHERE pass_id = ?",
    ],
    [
      'null voided',
      "UPDATE pass_versions SET pass_json = json_set(pass_json, '$.voided', json('null')) WHERE pass_id = ?",
    ],
    [
      'null expiry',
      "UPDATE pass_versions SET pass_json = json_set(pass_json, '$.expirationDate', json('null')) WHERE pass_id = ?",
    ],
    [
      'non-ISO expiry',
      "UPDATE pass_versions SET pass_json = json_set(pass_json, '$.expirationDate', 'Mon, 01 Jan 2099 00:00:00 GMT') WHERE pass_id = ?",
    ],
  ] as const)('masks assets and refuses minting after %s', async (_label, sql) => {
    const { scanner, pass, image } = await fixture();
    const before = await image();
    expect(before.status).toBe(200);
    await before.body?.cancel();
    await run(kit.env.DB, sql, [pass.id]);
    await missing(await image());
    await expect(genericAssetGrantFor(kit, scanner, pass.id)).rejects.toMatchObject({
      code: 'ASSET_NOT_FOUND',
    });
  });

  it('accepts a valid ISO expiry exactly equal to the current clock', async () => {
    const { scanner, pass } = await fixture();
    await run(
      kit.env.DB,
      "UPDATE pass_versions SET pass_json = json_set(pass_json, '$.expirationDate', ?) WHERE pass_id = ?",
      [new Date(kit.clock.now()).toISOString(), pass.id],
    );
    const grant = await genericAssetGrantFor(kit, scanner, pass.id);
    const response = await kit.get(
      scanner.headers,
      `/passes/${pass.id}/assets/icon.png?g=${grant}`,
    );
    expect(response.status).toBe(200);
  });

  it('binds canonical Wallet content without exposing a JSON fingerprint', async () => {
    const { scanner, pass, image } = await fixture();
    const first = await genericAssetGrantFor(kit, scanner, pass.id);
    const row = await kit.env.DB.prepare(
      'SELECT pass_json FROM pass_versions WHERE pass_id = ? AND version = ?',
    )
      .bind(pass.id, pass.version)
      .first<{ pass_json: string | null }>();
    if (!row?.pass_json) throw new Error('Wallet JSON fixture missing');
    await run(
      kit.env.DB,
      'UPDATE pass_versions SET pass_json = ? WHERE pass_id = ? AND version = ?',
      [JSON.stringify(JSON.parse(row.pass_json), null, 2), pass.id, pass.version],
    );
    const second = await genericAssetGrantFor(kit, scanner, pass.id);
    expect(second).not.toBe(first);
    expect(first).not.toContain(pass.serial);
    expect(
      (await kit.get(scanner.headers, `/passes/${pass.id}/assets/icon.png?g=${first}`)).status,
    ).toBe(200);
    expect(
      (await kit.get(scanner.headers, `/passes/${pass.id}/assets/icon.png?g=${second}`)).status,
    ).toBe(200);
    expect((await image()).status).toBe(200);
  });

  it('permits metadata-only personalization changes but invalidates the older grant', async () => {
    const { scanner, pass, image } = await fixture();
    const published = await publishPass(kit.ctx, {
      passId: pass.id,
      cause: 'admin',
      actor: { type: 'system', id: null },
      mutate: (current) => ({
        personalization: { ...current.personalization, tier: 'metadata-only' },
      }),
    });
    expect(published.changed).toBe(false);
    const current = await candidateById(kit.env.DB, kit.org.id, pass.id);
    expect(current?.walletVersion).toBe(pass.version);
    expect(current?.pass.version).toBeGreaterThan(pass.version);
    expect(JSON.parse(current?.versionPersonalization ?? '{}')).not.toHaveProperty('tier');
    expect(current?.pass.personalization).toMatchObject({ tier: 'metadata-only' });
    await missing(await image());
    const next = await genericAssetGrantFor(kit, scanner, pass.id);
    expect(
      (await kit.get(scanner.headers, `/passes/${pass.id}/assets/icon.png?g=${next}`)).status,
    ).toBe(200);
  });

  it('preserves opaque Wallet-version personalization and binds it independently', async () => {
    const { scanner, pass, image } = await fixture();
    const candidate = await candidateById(kit.env.DB, kit.org.id, pass.id);
    if (!candidate) throw new Error('Wallet snapshot fixture missing');
    for (const value of [null, '', '{malformed', '[]']) {
      expect(
        assetWalletActive({ ...candidate, versionPersonalization: value }, kit.clock.now()),
      ).toBe(true);
    }
    await run(kit.env.DB, "UPDATE pass_versions SET personalization = '[]' WHERE pass_id = ?", [
      pass.id,
    ]);
    await missing(await image());
    const next = await genericAssetGrantFor(kit, scanner, pass.id);
    expect(
      (await kit.get(scanner.headers, `/passes/${pass.id}/assets/icon.png?g=${next}`)).status,
    ).toBe(200);
  });

  it('binds opaque nullable Wallet template provenance without requiring it to match the pass', async () => {
    const { scanner, pass, image } = await fixture();
    const candidate = await candidateById(kit.env.DB, kit.org.id, pass.id);
    if (!candidate) throw new Error('Wallet snapshot fixture missing');
    for (const value of [null, '', 'another-version']) {
      expect(
        assetWalletActive({ ...candidate, walletTemplateVersion: value }, kit.clock.now()),
      ).toBe(true);
    }
    await run(
      kit.env.DB,
      "UPDATE pass_versions SET template_version = 'another-version' WHERE pass_id = ?",
      [pass.id],
    );
    await missing(await image());
    const next = await genericAssetGrantFor(kit, scanner, pass.id);
    expect(
      (await kit.get(scanner.headers, `/passes/${pass.id}/assets/icon.png?g=${next}`)).status,
    ).toBe(200);
  });

  it('rejects missing, nonpositive or unsafe signing identity revisions', async () => {
    const { pass } = await fixture();
    const candidate = await candidateById(kit.env.DB, kit.org.id, pass.id);
    if (!candidate) throw new Error('Wallet snapshot fixture missing');
    for (const revision of [null, 0, -1, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(assetWalletActive({ ...candidate, identityRevision: revision }, kit.clock.now())).toBe(
        false,
      );
    }
  });

  it('binds the selected Wallet row version even when the pass version is unchanged', async () => {
    const { scanner, pass } = await fixture();
    await run(
      kit.env.DB,
      `INSERT INTO pass_versions
      (pass_id, version, object_key, object_sha256, template_version, personalization, pass_json,
       cause, actor_type, actor_id, created_at)
      SELECT pass_id, version + 1, object_key, object_sha256, template_version, personalization,
       pass_json, cause, actor_type, actor_id, created_at
      FROM pass_versions WHERE pass_id = ? AND version = ?`,
      [pass.id, pass.version],
    );
    await run(kit.env.DB, 'UPDATE passes SET version = version + 1 WHERE id = ?', [pass.id]);
    const grant = await genericAssetGrantFor(kit, scanner, pass.id);
    await run(kit.env.DB, 'DELETE FROM pass_versions WHERE pass_id = ? AND version = ?', [
      pass.id,
      pass.version + 1,
    ]);
    await missing(await kit.get(scanner.headers, `/passes/${pass.id}/assets/icon.png?g=${grant}`));
    const next = await genericAssetGrantFor(kit, scanner, pass.id);
    expect(
      (await kit.get(scanner.headers, `/passes/${pass.id}/assets/icon.png?g=${next}`)).status,
    ).toBe(200);
  });

  it('never falls back to an older Wallet JSON after the latest version was purged', async () => {
    const { scanner, pass, image } = await fixture();
    await run(
      kit.env.DB,
      `INSERT INTO pass_versions
      (pass_id, version, object_key, object_sha256, template_version, personalization, pass_json,
       cause, actor_type, actor_id, created_at)
      SELECT pass_id, version + 1, object_key, object_sha256, template_version, personalization,
       NULL, cause, actor_type, actor_id, created_at
      FROM pass_versions WHERE pass_id = ? AND version = ?`,
      [pass.id, pass.version],
    );
    await run(kit.env.DB, 'UPDATE passes SET version = version + 1 WHERE id = ?', [pass.id]);
    await missing(await image());
    await expect(genericAssetGrantFor(kit, scanner, pass.id)).rejects.toMatchObject({
      code: 'ASSET_NOT_FOUND',
    });
  });
});
