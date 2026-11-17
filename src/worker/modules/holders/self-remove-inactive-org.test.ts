import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { makeUser } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { startCredentialTransfer } from '../passes/credential-transfer.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { atOwnerWrite } from './fixed-barcode-test-fixtures.ts';
import { getHolderPass } from './repo.ts';
import { runAttachHookA } from './service.ts';
import { attachWaitingPassesForEmail } from './service-attach.ts';
import { removePassFromUser } from './service-remove.ts';
import { ownerSessionId } from './test-auth-fixtures.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await setupKit();
});
afterEach(async () => {
  await run(kit.env.DB, "UPDATE orgs SET status = 'active' WHERE id = ?", [kit.org.id]);
});

let n = 0;
const email = () => `inactive-org-${++n}@example.test`;
const setOrg = (status: 'active' | 'suspended' | 'deleted') =>
  run(kit.env.DB, 'UPDATE orgs SET status = ? WHERE id = ?', [status, kit.org.id]);
const count = async (sql: string, id: string) =>
  (await first<{ n: number }>(kit.env.DB, sql, [id]))?.n;

/** A pass on its owner's account, with the owner's live session. */
async function owned() {
  const e = email();
  const user = await makeUser(kit.fx, { primaryEmail: e });
  const pass = await kit.pass({ holderEmail: e });
  await runAttachHookA(jobCtxOf(kit), pass.id);
  expect((await getPass(kit.env.DB, pass.id))?.ownerUserId).toBe(user.id);
  return { e, user, pass, session: await ownerSessionId(kit, user.id) };
}

describe('the owner removes a pass of an inactive org', () => {
  it.each(['suspended', 'deleted'] as const)(
    'unlinks it as it is when the org is %s',
    async (status) => {
      const { e, user, pass, session } = await owned();
      const before = await getPass(kit.env.DB, pass.id);
      await setOrg(status);
      const result = await removePassFromUser(kit.ctx, pass.id, user.id, session);
      expect(result).toEqual({ transferId: null, state: 'completed' });
      expect(await getPass(kit.env.DB, pass.id)).toMatchObject({
        ownerUserId: null,
        holderEmail: e,
        credentialGeneration: before?.credentialGeneration,
        authToken: before?.authToken,
        downloadToken: before?.downloadToken,
      });
      const blocks = 'SELECT count(*) AS n FROM pass_attach_blocks WHERE pass_id = ?';
      expect(await count(blocks, pass.id)).toBe(1);
      const transfers = 'SELECT count(*) AS n FROM pass_credential_transfers WHERE pass_id = ?';
      expect(await count(transfers, pass.id)).toBe(0);
      const audit = await first<{ detail: string }>(
        kit.env.DB,
        "SELECT detail FROM audit_log WHERE action = 'holder.remove' AND target_id = ?",
        [pass.id],
      );
      expect(JSON.parse(audit?.detail ?? 'null')).toEqual({ block: true, rotated: false });
      // The block holds once the org is back: the next sign-in does not link it again.
      await setOrg('active');
      expect(await attachWaitingPassesForEmail(jobCtxOf(kit), user.id, e)).toBe(0);
    },
    120_000,
  );

  it('re-signs on removal while the org is active (positive control)', async () => {
    const { user, pass, session } = await owned();
    const before = await getPass(kit.env.DB, pass.id);
    const result = await removePassFromUser(jobCtxOf(kit), pass.id, user.id, session);
    expect(result.state).toBe('completed');
    const after = await getPass(kit.env.DB, pass.id);
    expect(after?.ownerUserId).toBeNull();
    expect(after?.authToken).not.toBe(before?.authToken);
  });

  it('refuses the unlink when the org is reactivated before it commits', async () => {
    const { user, pass, session } = await owned();
    await setOrg('suspended');
    const race = atOwnerWrite(kit, () => setOrg('active'));
    await expect(removePassFromUser(race.ctx, pass.id, user.id, session)).rejects.toMatchObject({
      code: 'PASS_CONFLICT',
    });
    expect(race.fired()).toBe(true);
    expect((await getPass(kit.env.DB, pass.id))?.ownerUserId).toBe(user.id);
  });

  it('still refuses a re-sign in a suspended org (transfer insert guard)', async () => {
    const { user, pass, session } = await owned();
    const expected = await getHolderPass(kit.env.DB, pass.id, null);
    if (!expected) throw new Error('Missing pass');
    await setOrg('suspended');
    await expect(
      startCredentialTransfer(
        kit.ctx,
        { type: 'user', id: user.id },
        pass.id,
        { holderEmail: expected.holderEmail, ownerUserId: null },
        null,
        { kind: 'self-remove', expected, userId: user.id, sessionId: session },
      ),
    ).rejects.toMatchObject({ code: 'PASS_CONFLICT' });
    const transfers = 'SELECT count(*) AS n FROM pass_credential_transfers WHERE pass_id = ?';
    expect(await count(transfers, pass.id)).toBe(0);
    expect((await getPass(kit.env.DB, pass.id))?.ownerUserId).toBe(user.id);
  });
});
