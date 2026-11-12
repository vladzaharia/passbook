import { describe, expect, it } from 'vitest';
import { makeSession } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import type { Kit } from '../passes/pass-test-fixtures.ts';
import { setDownloadToken } from '../passes/repo.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { atOwnerWrite, fixedBarcodePass } from './fixed-barcode-test-fixtures.ts';
import { attachWaitingPassesForEmail } from './service-attach.ts';
import { removePassFromUser } from './service-remove.ts';

async function ownedStaticPass() {
  const fixture = await fixedBarcodePass();
  const { kit, user, email } = fixture;
  expect(await attachWaitingPassesForEmail(jobCtxOf(kit), user.id, email)).toBe(1);
  const session = await makeSession(kit.fx, { userId: user.id });
  return { ...fixture, sessionId: await sha256Hex(session.cookieValue) };
}

const owner = async (kit: Kit, id: string) => (await getPass(kit.env.DB, id))?.ownerUserId;
const rows = (kit: Kit, sql: string, id: string) =>
  first<{ n: number }>(kit.env.DB, sql, [id]).then((row) => row?.n);

describe('owner removes a pass whose credential cannot change', () => {
  it('unlinks, blocks re-attachment and keeps the credential', async () => {
    const { kit, pass, user, email, sessionId } = await ownedStaticPass();
    const linked = await getPass(kit.env.DB, pass.id);
    const result = await removePassFromUser(jobCtxOf(kit), pass.id, user.id, sessionId);
    expect(result).toEqual({ transferId: null, state: 'completed' });
    const after = await getPass(kit.env.DB, pass.id);
    expect(after).toMatchObject({
      ownerUserId: null,
      holderEmail: email,
      credentialGeneration: linked?.credentialGeneration,
      downloadToken: linked?.downloadToken,
      serial: linked?.serial,
      scanCode: linked?.scanCode,
      authToken: linked?.authToken,
    });
    expect(
      await rows(kit, 'SELECT count(*) AS n FROM pass_attach_blocks WHERE pass_id = ?', pass.id),
    ).toBe(1);
    const audit = await first<{ detail: string }>(
      kit.env.DB,
      "SELECT detail FROM audit_log WHERE action = 'holder.remove' AND target_id = ?",
      [pass.id],
    );
    expect(JSON.parse(audit?.detail ?? 'null')).toEqual({ block: true, rotated: false });
    expect(
      await rows(
        kit,
        'SELECT count(*) AS n FROM pass_credential_transfers WHERE pass_id = ?',
        pass.id,
      ),
    ).toBe(0);
    // The block stops the next sign-in from linking it again.
    expect(await attachWaitingPassesForEmail(jobCtxOf(kit), user.id, email)).toBe(0);
    expect(await owner(kit, pass.id)).toBeNull();
  }, 120_000);

  it.each(['changed', 'disabled', 'signed-out'] as const)(
    'does not unlink when the pass or user is %s at the write',
    async (change) => {
      const { kit, pass, user, sessionId } = await ownedStaticPass();
      const race = atOwnerWrite(kit, async () => {
        if (change === 'disabled')
          return run(kit.env.DB, "UPDATE users SET status = 'disabled' WHERE id = ?", [user.id]);
        if (change === 'signed-out')
          return run(kit.env.DB, 'DELETE FROM sessions WHERE user_id = ?', [user.id]);
        const current = await getPass(kit.env.DB, pass.id);
        if (!current) throw new Error('Missing pass');
        return setDownloadToken(kit.env.DB, current, kit.fx.ids.token(), kit.clock.now());
      });
      await expect(removePassFromUser(race.ctx, pass.id, user.id, sessionId)).rejects.toBeDefined();
      expect(race.fired()).toBe(true);
      expect(await owner(kit, pass.id)).toBe(user.id);
      expect(
        await rows(kit, 'SELECT count(*) AS n FROM pass_attach_blocks WHERE pass_id = ?', pass.id),
      ).toBe(0);
    },
    120_000,
  );

  it('refuses a user who is not the owner', async () => {
    const { kit, pass, sessionId } = await ownedStaticPass();
    await expect(
      removePassFromUser(jobCtxOf(kit), pass.id, kit.fx.ids.id(), sessionId),
    ).rejects.toMatchObject({ code: 'PASS_CONFLICT' });
  }, 120_000);
});
