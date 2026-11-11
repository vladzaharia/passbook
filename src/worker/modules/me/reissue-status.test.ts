import { describe, expect, it } from 'vitest';
import { makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { run } from '../../platform/db.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { attachWaitingPassesForEmail } from '../holders/service.ts';
import { setupKit } from '../passes/pass-test-fixtures.ts';
import { getPass } from '../passes/repo-read-pass.ts';

describe('waiting pass requiring reissue', () => {
  it('shows issuer guidance only to the current verified unblocked recipient', async () => {
    const kit = await setupKit();
    const email = 'waiting@example.test';
    // Issue while no account has verified this address: the pass really is waiting.
    const pass = await kit.pass({ holderEmail: email });
    const user = await makeUser(kit.fx, { primaryEmail: email });
    const other = await makeUser(kit.fx);
    const session = await makeSession(kit.fx, { userId: user.id });
    const stranger = await makeSession(kit.fx, { userId: other.id });
    await run(
      kit.env.DB,
      `INSERT INTO pass_holder_reissue_required
      (pass_id, org_id, mode, user_id, credential_generation, version, revision,
       lifecycle_generation, link_generation, release_id, detected_at)
      SELECT id, org_id, mode, ?, credential_generation, version, revision,
        lifecycle_generation, link_generation, release_id, ? FROM passes WHERE id = ?`,
      [user.id, kit.clock.now(), pass.id],
    );
    const app = createApp({
      clock: kit.clock,
      stores: { ...denyAllStores, sessions: createSessionStore(kit.env, kit.clock) },
    });
    const list = async (headers: Record<string, string>) => {
      const response = await app.request(
        'https://wallet.test/api/v1/me/passes',
        { headers },
        kit.env,
      );
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).not.toContain(email);
      expect(text).not.toContain(pass.downloadToken);
      expect(text).not.toContain(pass.authToken);
      return JSON.parse(text) as {
        items: unknown[];
        reissueRequired: { passId: string; orgName: string }[];
      };
    };
    expect(await list(session.headers)).toMatchObject({
      items: [],
      reissueRequired: [{ passId: pass.id, orgName: kit.org.name }],
    });
    expect((await list(stranger.headers)).reissueRequired).toEqual([]);
    expect((await app.request('https://wallet.test/api/v1/me/passes', {}, kit.env)).status).toBe(
      401,
    );

    await run(kit.env.DB, 'DELETE FROM user_emails WHERE user_id = ?', [user.id]);
    expect((await list(session.headers)).reissueRequired).toEqual([]);
    await run(
      kit.env.DB,
      "INSERT INTO user_emails (email, user_id, verified_via, verified_at) VALUES (?, ?, 'admin', ?)",
      [email, user.id, kit.clock.now()],
    );
    expect((await list(session.headers)).reissueRequired).toHaveLength(1);
    await run(
      kit.env.DB,
      'INSERT INTO pass_attach_blocks (pass_id, user_id, created_at) VALUES (?, ?, ?)',
      [pass.id, user.id, kit.clock.now()],
    );
    expect((await list(session.headers)).reissueRequired).toEqual([]);
    await run(kit.env.DB, 'DELETE FROM pass_attach_blocks WHERE pass_id = ? AND user_id = ?', [
      pass.id,
      user.id,
    ]);
    expect((await list(session.headers)).reissueRequired).toHaveLength(1);
    await run(kit.env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [kit.org.id]);
    expect((await list(session.headers)).reissueRequired).toEqual([]);
    await run(kit.env.DB, "UPDATE orgs SET status = 'active' WHERE id = ?", [kit.org.id]);
    expect((await list(session.headers)).reissueRequired).toHaveLength(1);

    const before = await getPass(kit.env.DB, pass.id);
    if (!before) throw new Error('Missing waiting pass');
    expect(await attachWaitingPassesForEmail(kit.ctx, user.id, email)).toBe(1);
    expect((await getPass(kit.env.DB, pass.id))?.credentialGeneration).toBe(
      before.credentialGeneration + 1,
    );
    expect((await list(session.headers)).reissueRequired).toEqual([]);
  }, 120_000);
});
