// A joined card reaches the portal of the address's owner, and of nobody else.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { first, run } from '../../platform/db.ts';
import { signInMagicLink } from '../auth/service.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { resumeVerifiedHolderAttachments } from '../holders/transfer-jobs.ts';
import { listMyPasses } from '../me/service.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { type PublicKit, publicKit, turnstile, verdictOf } from './public-test-fixtures.ts';

let t: PublicKit;
beforeAll(async () => {
  t = await publicKit();
}, 120_000);
afterAll(() => t.restore());
beforeEach(async () => {
  await run(t.kit.env.DB, "DELETE FROM counters WHERE key = 'join:platform'");
  turnstile.verdict = verdictOf();
});

const sign = { ipPrefix: null, userAgent: null };
const address = () => `joined-${Math.random().toString(36).slice(2)}@example.test`;

async function joinWith(email: string) {
  const l = await t.link({ askEmail: true });
  const res = await t.post(l, { email });
  expect(res.status).toBe(200);
  const row = await first<{ id: string }>(
    t.kit.env.DB,
    'SELECT id FROM passes WHERE holder_email = ? ORDER BY id DESC LIMIT 1',
    [email],
  );
  if (!row) throw new Error('no joined pass');
  return row.id;
}

describe('join, then sign in with the same address', () => {
  it('the card is in My passes, owned by the signer, on new credentials', async () => {
    const email = address();
    const passId = await joinWith(email);
    const before = await getPass(t.kit.env.DB, passId);
    expect(before?.ownerUserId).toBeNull();
    const ctx = jobCtxOf(t.kit);
    const { userId } = await signInMagicLink(ctx, email, sign);
    const after = await getPass(t.kit.env.DB, passId);
    expect(after?.ownerUserId).toBe(userId);
    // The browser that submitted the form held the old link and code; they no longer open it.
    expect(after?.linkGeneration).toBeGreaterThan(before?.linkGeneration ?? 0);
    const list = await listMyPasses(ctx, userId, { limit: 20 });
    expect(list.items.map((p) => p.id)).toEqual([passId]);
  });

  it('another account, and the minute sweep, leave the card unattached', async () => {
    const email = address();
    const passId = await joinWith(email);
    const ctx = jobCtxOf(t.kit);
    // A different address verified by the signer: nothing of the joiner's address is proved.
    const { userId } = await signInMagicLink(ctx, address(), sign);
    for (let i = 0; i < 4; i++) await resumeVerifiedHolderAttachments(ctx);
    expect((await getPass(t.kit.env.DB, passId))?.ownerUserId).toBeNull();
    expect((await listMyPasses(ctx, userId, { limit: 20 })).items).toEqual([]);
  });
});
