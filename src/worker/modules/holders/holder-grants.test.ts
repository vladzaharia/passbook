import { beforeAll, describe, expect, it } from 'vitest';
import { makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { insertPersonalization, markPersonalizationPublished } from '../apple/repo-personalize.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { finishCredentialTransfer } from '../passes/credential-transfer.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { runAttachHookA } from './service.ts';
import { removePassFromUser } from './service-remove.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await setupKit();
});
let n = 0;
const email = () => `grant-${++n}@example.test`;

describe('holder grants', () => {
  it('attaches a pass to the user who verified its address (verified_email)', async () => {
    const e = email();
    const user = await makeUser(kit.fx, { primaryEmail: e });
    const pass = await kit.pass({ holderEmail: e });
    await runAttachHookA(jobCtxOf(kit), pass.id);
    expect((await getPass(kit.env.DB, pass.id))?.ownerUserId).toBe(user.id);
  });

  it('refuses an attach for an address the user did not verify', async () => {
    const e = email();
    await makeUser(kit.fx, { primaryEmail: e, verified: false });
    const pass = await kit.pass({ holderEmail: e });
    await runAttachHookA(jobCtxOf(kit), pass.id);
    expect((await getPass(kit.env.DB, pass.id))?.ownerUserId).toBeNull();
  });

  it('removes a pass on the owner session, and refuses a revoked session (session)', async () => {
    const e = email();
    const user = await makeUser(kit.fx, { primaryEmail: e });
    const pass = await kit.pass({ holderEmail: e });
    await runAttachHookA(jobCtxOf(kit), pass.id);
    const session = await makeSession(kit.fx, { userId: user.id });
    const hash = await sha256Hex(session.cookieValue);
    await run(kit.env.DB, 'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?', [
      kit.clock.now(),
      hash,
    ]);
    await expect(removePassFromUser(jobCtxOf(kit), pass.id, user.id, hash)).rejects.toMatchObject({
      status: 403,
    });
    expect((await getPass(kit.env.DB, pass.id))?.ownerUserId).toBe(user.id);
    const live = await makeSession(kit.fx, { userId: user.id });
    const result = await removePassFromUser(
      jobCtxOf(kit),
      pass.id,
      user.id,
      await sha256Hex(live.cookieValue),
    );
    // The holder grant cannot retire assets yet (builder gap), so the sweep finishes it.
    expect(['pending', 'completed']).toContain(result.state);
    if (!result.transferId) throw new Error('Expected a transfer');
    await finishCredentialTransfer(jobCtxOf(kit), result.transferId);
    expect((await getPass(kit.env.DB, pass.id))?.ownerUserId).toBeNull();
  });

  it('personalizes on the captured credential and ignores a rotated auth token (device)', async () => {
    const pass = await kit.pass();
    const credential = { ...pass };
    const base = {
      tokenSha256: 'a'.repeat(64),
      envelope: {
        kekVersion: 1,
        iv: new Uint8Array(12),
        wrappedDek: new Uint8Array(8),
        ciphertext: new Uint8Array(8),
      },
      now: kit.clock.now(),
      fields: ['fullName'],
    };
    await insertPersonalization(jobCtxOf(kit), {
      ...base,
      pass: { ...credential, authToken: 'rotated' },
    });
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM pass_personalizations WHERE pass_id = ?', [pass.id]),
    ).toBeNull();
    await insertPersonalization(jobCtxOf(kit), { ...base, pass: credential });
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM pass_personalizations WHERE pass_id = ?', [pass.id]),
    ).not.toBeNull();
    expect(await markPersonalizationPublished(jobCtxOf(kit), credential, base.tokenSha256)).toBe(
      true,
    );
    expect(
      await markPersonalizationPublished(
        jobCtxOf(kit),
        { ...credential, authToken: 'rotated' },
        base.tokenSha256,
      ),
    ).toBe(false);
  });
});
