import { describe, expect, it } from 'vitest';
import { fixtures, makeEnv, makeOrg, makePass, makeTemplate } from '../../../test/helpers/index.ts';
import { makeJoinLink } from '../../../test/helpers/join.ts';
import {
  issueToken,
  revealToken,
  tokenKeys,
  tokenMac,
  tokenMatches,
  unsealToken,
} from './capability-token.ts';
import { first, run } from './db.ts';
import { readSeal } from './repo-capability-token.ts';

const TOKEN = 'demodemodemodemodemode';

describe('capability token purpose join', () => {
  it('its MAC never verifies as another purpose, and theirs never as join', async () => {
    const env = await makeEnv();
    const join = await tokenMac(env, 'join', TOKEN);
    for (const purpose of ['pass', 'bundle', 'apple-auth'] as const) {
      const other = await tokenMac(env, purpose, TOKEN);
      expect(other).not.toBe(join);
      expect(await tokenMatches(env, purpose, join, TOKEN)).toBe(false);
      expect(await tokenMatches(env, 'join', other, TOKEN)).toBe(false);
      expect((await tokenKeys(env, 'join', TOKEN))[0]).toBe(join);
    }
    expect(await tokenMatches(env, 'join', join, TOKEN)).toBe(true);
    expect(await tokenMatches(env, 'join', join, `${TOKEN}x`)).toBe(false);
    expect(await tokenMatches(env, 'join', join, join)).toBe(false);
  });

  it('reveals the link from its seal and rotation replaces it', async () => {
    const f = fixtures(await makeEnv());
    const org = await makeOrg(f);
    const template = makeTemplate({ id: 'tpl-join-token' });
    await makePass(f, { orgId: org.id, template: template.resolved });
    const link = await makeJoinLink(f, { orgId: org.id, templateId: template.resolved.id });
    expect(await revealToken(f.env, 'join', link.id, org.id, link.mac)).toBe(link.token);

    const next = await issueToken(f.env, 'join', link.id, org.id, 'Zz3dE6gH9jK2mN5pQ8sTvw');
    await run(
      f.env.DB,
      'UPDATE join_links SET token = ?, generation = generation + 1 WHERE id = ?',
      [next.mac, link.id],
    );
    await run(
      f.env.DB,
      'UPDATE join_link_seals SET kek_version = ?, iv = ?, wrapped_dek = ?, ciphertext = ? WHERE link_id = ?',
      [next.seal.kekVersion, next.seal.iv, next.seal.wrappedDek, next.seal.ciphertext, link.id],
    );
    expect(await revealToken(f.env, 'join', link.id, org.id, next.mac)).toBe(next.token);
    const row = await first<{ id: string }>(f.env.DB, 'SELECT id FROM join_links WHERE token = ?', [
      (await tokenKeys(f.env, 'join', link.token))[0],
    ]);
    expect(row).toBeNull();
  });

  it('refuses a seal that is not of the stored token, or of another link or org', async () => {
    const f = fixtures(await makeEnv());
    const org = await makeOrg(f);
    const other = await makeOrg(f);
    const template = makeTemplate({ id: 'tpl-join-seal' });
    await makePass(f, { orgId: org.id, template: template.resolved });
    const link = await makeJoinLink(f, { orgId: org.id, templateId: template.resolved.id });
    const seal = await readSeal(f.env.DB, 'join', link.id, org.id);
    // The row moved to a token the copy is not of: refused as stale.
    const moved = await tokenMac(f.env, 'join', 'Qq3dE6gH9jK2mN5pQ8sTvw');
    await expect(unsealToken(f.env, 'join', link.id, org.id, moved, seal)).rejects.toMatchObject({
      code: 'TOKEN_SEAL_MISMATCH',
    });
    // AAD is id|org|purpose: another org, another link id and another purpose cannot open the copy.
    await expect(
      unsealToken(f.env, 'join', link.id, other.id, link.mac, seal),
    ).rejects.toMatchObject({ code: 'TOKEN_SEAL_UNREADABLE' });
    await expect(
      unsealToken(f.env, 'join', 'other-link', org.id, link.mac, seal),
    ).rejects.toMatchObject({ code: 'TOKEN_SEAL_UNREADABLE' });
    await expect(unsealToken(f.env, 'pass', link.id, org.id, link.mac, seal)).rejects.toMatchObject(
      { code: 'TOKEN_SEAL_UNREADABLE' },
    );
    // No seal at all.
    await expect(unsealToken(f.env, 'join', link.id, org.id, link.mac, null)).rejects.toMatchObject(
      { code: 'TOKEN_SEAL_MISSING' },
    );
    // A plain value in the column is never shown.
    await expect(revealToken(f.env, 'join', link.id, org.id, TOKEN)).rejects.toMatchObject({
      code: 'TOKEN_NOT_SEALED',
    });
  });
});
