import { beforeAll, describe, expect, it } from 'vitest';
import { makeJoinLink } from '../../../../test/helpers/join.ts';
import { revealToken, tokenKeys, tokenMac } from '../../platform/capability-token.ts';
import { first } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { readSystemValue } from '../settings/repo.ts';
import { type Kit, setupKit } from './pass-test-fixtures.ts';
import { macSample } from './repo-token-remac.ts';
import { remacCapabilityTokens } from './token-remac.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await setupKit();
});
const kek = (byte: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(byte)));
const env = () => kit.env as unknown as Record<string, string | undefined>;
const row = (id: string) =>
  first<{ token: string; generation: number }>(
    kit.env.DB,
    'SELECT token, generation FROM join_links WHERE id = ?',
    [id],
  );

describe('tokens.remac for join links', () => {
  it('samples join links for the root probe', async () => {
    const pass = await kit.pass();
    const templateId = (
      await first<{ template_id: string }>(
        kit.env.DB,
        'SELECT template_id FROM passes WHERE id = ?',
        [pass.id],
      )
    )?.template_id;
    const link = await makeJoinLink(kit.fx, { orgId: kit.org.id, templateId: templateId ?? '' });
    expect((await macSample(kit.env.DB, 'join', 3)).map((r) => r.id)).toContain(link.id);

    env().KEK_V2 = kek(2);
    env().MAC_KEY_VERSION = '2';
    env().MAC_KEY_VERSION_PREVIOUS = '1';
    // Mid-rotation the old MAC still resolves.
    expect((await tokenKeys(kit.env, 'join', link.token)).includes(link.mac)).toBe(true);

    const job = jobCtxOf(kit);
    for (let i = 0; i < 6; i++) {
      await remacCapabilityTokens(job);
      if ((await readSystemValue(kit.env.DB, 'tokens.remacDone')) !== null) break;
    }
    const after = await row(link.id);
    expect(after?.token).toBe(await tokenMac(kit.env, 'join', link.token));
    expect(after?.token).not.toBe(link.mac);
    // The generation trigger moved with the token, so a submit in flight at the old one fails.
    expect(after?.generation).toBe(link.generation + 1);

    // With the previous root unset, the link resolves under the new root alone and its seal still opens.
    delete env().MAC_KEY_VERSION_PREVIOUS;
    const [current] = await tokenKeys(kit.env, 'join', link.token);
    expect(await first(kit.env.DB, 'SELECT id FROM join_links WHERE token = ?', [current])).toEqual(
      { id: link.id },
    );
    expect(await revealToken(kit.env, 'join', link.id, kit.org.id, after?.token ?? '')).toBe(
      link.token,
    );
  });
});
