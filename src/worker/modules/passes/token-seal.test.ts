import { beforeAll, describe, expect, it } from 'vitest';
import {
  isTokenMac,
  revealToken,
  sealToken,
  tokenMac,
  unsealToken,
} from '../../platform/capability-token.ts';
import { all, first, run } from '../../platform/db.ts';
import { bundleForToken } from '../bundles/public-service.ts';
import { createBundle, getBundleDto } from '../bundles/service.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { passForToken } from '../public/service.ts';
import { type Kit, setupKit } from './pass-test-fixtures.ts';
import { getPass } from './repo-read-pass.ts';

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

describe('token guards', () => {
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
});

describe('case-sensitive MAC guard', () => {
  it('refuses an upper-case prefix on the download and bundle tokens', async () => {
    const pass = await kit.pass();
    await expect(
      run(
        kit.env.DB,
        "UPDATE passes SET download_token = 'H1:abc', link_generation = link_generation + 1 WHERE id = ?",
        [pass.id],
      ),
    ).rejects.toThrow(/download_token must be a MAC/);
    const bundle = await createBundle(
      job(),
      actor,
      'live',
      { orgId: kit.org.id, passIds: [pass.id], name: 'Upper' },
      { kind: 'system' },
    );
    await expect(
      run(kit.env.DB, "UPDATE bundles SET token = 'H1:abc', token_rotated_at = 1 WHERE id = ?", [
        bundle.id,
      ]),
    ).rejects.toThrow(/token must be a MAC/);
  });
});

describe('a stored value that is not a MAC', () => {
  it('is never returned as a token: reveal and unseal refuse it with TOKEN_NOT_SEALED', async () => {
    const pass = await kit.pass();
    await expect(
      revealToken(kit.env, 'pass', pass.id, pass.orgId, 'plain-value'),
    ).rejects.toMatchObject({ code: 'TOKEN_NOT_SEALED' });
    await expect(
      unsealToken(kit.env, 'apple-auth', pass.id, pass.orgId, 'plain-value', null),
    ).rejects.toMatchObject({ code: 'TOKEN_NOT_SEALED' });
  });
});
