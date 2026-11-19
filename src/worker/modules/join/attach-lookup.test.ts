// A joined card whose credential cannot rotate is never linked to the owner as it is.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { first, run } from '../../platform/db.ts';
import { signInMagicLink } from '../auth/service.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { listMyPasses } from '../me/service.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { joinTemplate } from './join-test-fixtures.ts';
import { BASE, type PublicKit, publicKit, turnstile, verdictOf } from './public-test-fixtures.ts';

let t: PublicKit;
beforeAll(async () => {
  t = await publicKit((id) => joinTemplate(id, undefined, true));
}, 120_000);
afterAll(() => t.restore());

describe("a stranger joins with someone else's address on a template with a desk lookup", () => {
  it('the owner signing in does not receive the card, and is told it needs a new copy', async () => {
    turnstile.verdict = verdictOf();
    await run(t.kit.env.DB, "DELETE FROM counters WHERE key = 'join:platform'");
    const victim = `victim-${Math.random().toString(36).slice(2)}@example.test`;
    const l = await t.link({ askEmail: true });
    const res = await t.post(l, { email: victim });
    expect(res.status).toBe(303);
    const link = res.headers.get('location') ?? '';
    const row = await first<{ id: string }>(
      t.kit.env.DB,
      'SELECT id FROM passes WHERE holder_email = ? ORDER BY id DESC LIMIT 1',
      [victim],
    );
    if (!row) throw new Error('no joined pass');
    const before = await getPass(t.kit.env.DB, row.id);
    const ctx = jobCtxOf(t.kit);
    const { userId } = await signInMagicLink(ctx, victim, { ipPrefix: null, userAgent: null });
    // Linking as it is would leave the joiner's link and code working on a card in the victim's account.
    const after = await getPass(t.kit.env.DB, row.id);
    expect(after?.ownerUserId).toBeNull();
    expect(after?.linkGeneration).toBe(before?.linkGeneration);
    const mine = await listMyPasses(ctx, userId, { limit: 20 });
    expect(mine.items).toEqual([]);
    expect(mine.reissueRequired.map((r) => r.passId)).toEqual([row.id]);
    // The joiner's own card is still theirs, not the victim's.
    expect((await t.app.request(`${BASE}${link}`, {}, t.kit.env)).status).toBe(200);
  });
});
