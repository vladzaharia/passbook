import { beforeAll, describe, expect, it } from 'vitest';
import { stagePendingCredentialTransfer } from '../../../../test/helpers/credential-transfer.ts';
import { asLegacyTokens, makeOrg } from '../../../../test/helpers/index.ts';
import { isTokenMac, revealToken, sealToken, tokenMac } from '../../platform/capability-token.ts';
import { all, first, run } from '../../platform/db.ts';
import { bundleForToken } from '../bundles/public-service.ts';
import { createBundle, getBundleDto } from '../bundles/service.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { passForToken } from '../public/service.ts';
import { linksOf } from './detail.ts';
import { type Kit, setupKit } from './pass-test-fixtures.ts';
import { getPass } from './repo-read-pass.ts';
import { sealCapabilityTokens } from './token-seal.ts';

const actor = { type: 'system', id: null } as const;
let kit: Kit;
const job = () => jobCtxOf(kit);

beforeAll(async () => {
  kit = await setupKit();
});

async function plainOf(passId: string) {
  const row = await first<{ download_token: string; org_id: string }>(
    kit.env.DB,
    'SELECT download_token, org_id FROM passes WHERE id = ?',
    [passId],
  );
  if (!row) throw new Error('missing pass');
  return revealToken(kit.env, 'pass', passId, row.org_id, row.download_token);
}

/** Puts a pass back to its pre-0059 shape: the plain token in the column, no sealed copy. */
async function makeLegacy(passId: string, token: string) {
  await run(kit.env.DB, 'DELETE FROM pass_token_seals WHERE pass_id = ?', [passId]);
  await asLegacyTokens(kit.env.DB, () =>
    run(kit.env.DB, 'UPDATE passes SET download_token = ? WHERE id = ?', [token, passId]),
  );
}

const linkOf = (row: { id: string; orgId: string; downloadToken: string } | null) =>
  row ? revealToken(kit.env, 'pass', row.id, row.orgId, row.downloadToken) : null;

const state = (passId: string) =>
  first<{ row_version: number; download_token: string; gen: number | null; dirty: number }>(
    kit.env.DB,
    `SELECT p.row_version, p.download_token,
       (SELECT generation FROM wallet_provider_pass_authority WHERE pass_id = p.id) AS gen,
       (SELECT count(*) FROM wallet_provider_instance_dirty) AS dirty
     FROM passes p WHERE p.id = ?`,
    [passId],
  );

describe('capability tokens at rest', () => {
  it('stores a new pass token as a MAC with a sealed copy and finds it by MAC', async () => {
    const pass = await kit.pass();
    expect(isTokenMac(pass.downloadToken)).toBe(true);
    const plain = await plainOf(pass.id);
    expect(isTokenMac(plain)).toBe(false);
    expect(pass.downloadToken).toBe(await tokenMac(kit.env, 'pass', plain));
    expect((await passForToken(job(), plain)).id).toBe(pass.id);
    expect((await getPass(kit.env.DB, pass.id))?.downloadToken).toBe(pass.downloadToken);
    const stored = await all(kit.env.DB, 'SELECT * FROM passes WHERE download_token = ?', [plain]);
    expect(stored).toHaveLength(0);
  });

  it('never resolves the stored MAC or another purpose', async () => {
    const pass = await kit.pass();
    await expect(passForToken(job(), pass.downloadToken)).rejects.toMatchObject({ status: 404 });
    const plain = await plainOf(pass.id);
    await expect(bundleForToken(job(), plain)).rejects.toMatchObject({ status: 404 });
    const bundle = await createBundle(
      job(),
      actor,
      'live',
      { orgId: kit.org.id, passIds: [pass.id], name: 'B' },
      { kind: 'system' },
    );
    const token = bundle.url?.split('/b/')[1] ?? '';
    await expect(passForToken(job(), token)).rejects.toMatchObject({ status: 404 });
    expect((await bundleForToken(job(), token)).id).toBe(bundle.id);
  });

  it('refuses a sealed copy moved to another pass or organization', async () => {
    const a = await kit.pass();
    const b = await kit.pass();
    const seal = await first<{ kek_version: number; iv: ArrayBuffer }>(
      kit.env.DB,
      'SELECT kek_version, iv FROM pass_token_seals WHERE pass_id = ?',
      [a.id],
    );
    expect(seal).not.toBeNull();
    await run(
      kit.env.DB,
      `UPDATE pass_token_seals SET wrapped_dek = (SELECT wrapped_dek FROM pass_token_seals WHERE pass_id = ?),
         ciphertext = (SELECT ciphertext FROM pass_token_seals WHERE pass_id = ?), iv = (SELECT iv FROM pass_token_seals WHERE pass_id = ?)
       WHERE pass_id = ?`,
      [a.id, a.id, a.id, b.id],
    );
    await expect(
      revealToken(kit.env, 'pass', b.id, b.orgId, b.downloadToken),
    ).rejects.toMatchObject({ code: 'TOKEN_SEAL_UNREADABLE' });
    await expect(
      revealToken(kit.env, 'pass', a.id, 'other-org', a.downloadToken),
    ).rejects.toMatchObject({ code: 'TOKEN_SEAL_MISSING' });
  });
});

describe('sealing legacy tokens', () => {
  it('shows the same link before and after, clears the plain token, keeps row_version', async () => {
    const pass = await kit.pass();
    const legacy = `legacy-${pass.id}-${'x'.repeat(24)}`;
    await makeLegacy(pass.id, legacy);
    const before = await getPass(kit.env.DB, pass.id);
    if (!before) throw new Error('missing');
    expect((await passForToken(job(), legacy)).id).toBe(pass.id);
    const linksBefore = await linksOf(job(), before);
    expect(linksBefore.publicUrl).toContain(legacy);
    const s0 = await state(pass.id);

    await sealCapabilityTokens(job());

    const after = await getPass(kit.env.DB, pass.id);
    if (!after) throw new Error('missing');
    expect(isTokenMac(after.downloadToken)).toBe(true);
    expect(await linksOf(job(), after)).toEqual(linksBefore);
    expect((await passForToken(job(), legacy)).id).toBe(pass.id);
    expect(
      await all(kit.env.DB, 'SELECT 1 FROM passes WHERE download_token = ?', [legacy]),
    ).toEqual([]);
    const s1 = await state(pass.id);
    expect(s1?.row_version).toBe(s0?.row_version);
    expect(s1?.gen).toBe(s0?.gen);
    expect(s1?.dirty).toBe(s0?.dirty);
    expect(after.linkGeneration).toBe(before.linkGeneration);
  });

  it('skips a pass with a pending credential transfer ', async () => {
    const pass = await kit.pass();
    const legacy = `pending-${pass.id}-${'y'.repeat(24)}`;
    await stagePendingCredentialTransfer(kit.env.DB, pass.id, {
      id: kit.fx.ids.id(),
      token: legacy,
      now: kit.clock.now(),
    });
    await run(kit.env.DB, 'DELETE FROM pass_token_seals WHERE pass_id = ?', [pass.id]);
    await asLegacyTokens(kit.env.DB, () =>
      run(kit.env.DB, 'UPDATE passes SET download_token = ? WHERE id = ?', [legacy, pass.id]),
    );
    await sealCapabilityTokens(job());
    expect((await state(pass.id))?.download_token).toBe(legacy);
  });

  it('seals a pass of a suspended org too, by the trusted write', async () => {
    const org = await makeOrg(kit.fx, { name: 'Suspended Org' });
    const pass = await kit.pass({ orgId: org.id });
    const legacy = `suspended-${pass.id}-${'z'.repeat(24)}`;
    await makeLegacy(pass.id, legacy);
    await run(kit.env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [org.id]);
    await sealCapabilityTokens(job());
    const row = await getPass(kit.env.DB, pass.id);
    expect(row?.downloadToken).toBe(await tokenMac(kit.env, 'pass', legacy));
    expect(await linkOf(row)).toBe(legacy);
  });

  it('keeps plain tokens and unsealed rotations out of the database', async () => {
    const pass = await kit.pass();
    await expect(
      run(
        kit.env.DB,
        "UPDATE passes SET download_token = 'plain', link_generation = link_generation + 1 WHERE id = ?",
        [pass.id],
      ),
    ).rejects.toThrow(/must be a MAC/);
    await expect(
      run(kit.env.DB, "UPDATE passes SET download_token = 'h1:forgot' WHERE id = ?", [pass.id]),
    ).rejects.toThrow(/must move link_generation/);
    await run(
      kit.env.DB,
      "UPDATE passes SET download_token = 'h1:ok', link_generation = link_generation + 1 WHERE id = ?",
      [pass.id],
    );
  });

  it('refuses a sealed copy of another token and lists a bundle with no link', async () => {
    const pass = await kit.pass();
    const other = await sealToken(kit.env, 'pass', pass.id, pass.orgId, 'another-token');
    await run(
      kit.env.DB,
      'UPDATE pass_token_seals SET iv = ?, wrapped_dek = ?, ciphertext = ?, kek_version = ? WHERE pass_id = ?',
      [other.iv, other.wrappedDek, other.ciphertext, other.kekVersion, pass.id],
    );
    await expect(
      revealToken(kit.env, 'pass', pass.id, pass.orgId, pass.downloadToken),
    ).rejects.toMatchObject({ code: 'TOKEN_SEAL_MISMATCH' });
    const bundle = await createBundle(
      job(),
      actor,
      'live',
      { orgId: kit.org.id, passIds: [(await kit.pass()).id], name: 'Broken' },
      { kind: 'system' },
    );
    await run(kit.env.DB, 'DELETE FROM bundle_token_seals WHERE bundle_id = ?', [bundle.id]);
    expect((await getBundleDto(job(), bundle.id, null)).url).toBeNull();
  });

  it('seals a bundle token and is idempotent', async () => {
    const pass = await kit.pass();
    const bundle = await createBundle(
      job(),
      actor,
      'live',
      { orgId: kit.org.id, passIds: [pass.id], name: 'Legacy' },
      { kind: 'system' },
    );
    const plain = bundle.url?.split('/b/')[1] ?? '';
    await run(kit.env.DB, 'DELETE FROM bundle_token_seals WHERE bundle_id = ?', [bundle.id]);
    await asLegacyTokens(kit.env.DB, () =>
      run(kit.env.DB, 'UPDATE bundles SET token = ? WHERE id = ?', [plain, bundle.id]),
    );
    await sealCapabilityTokens(job());
    await sealCapabilityTokens(job());
    const row = await first<{ token: string }>(
      kit.env.DB,
      'SELECT token FROM bundles WHERE id = ?',
      [bundle.id],
    );
    expect(row?.token).toBe(await tokenMac(kit.env, 'bundle', plain));
    const again = await createBundle(
      job(),
      actor,
      'live',
      { orgId: kit.org.id, passIds: [pass.id], name: 'Other' },
      { kind: 'system' },
    );
    expect(again.url).not.toBe(bundle.url);
    expect(await bundleForToken(job(), plain)).toMatchObject({ id: bundle.id });
    const seals = await all(kit.env.DB, 'SELECT 1 FROM bundle_token_seals WHERE bundle_id = ?', [
      bundle.id,
    ]);
    expect(seals).toHaveLength(1);
  });
});
