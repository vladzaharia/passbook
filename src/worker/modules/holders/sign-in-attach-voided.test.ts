// A pass voided or removed before its holder's first sign-in still attaches, so My passes lists it
// as ended (the holder's way to see why it stopped working).
import { describe, expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import { signInMagicLink } from '../auth/service.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { setupKit } from '../passes/pass-test-fixtures.ts';
import { getPass } from '../passes/repo-read-pass.ts';

const sign = { ipPrefix: null, userAgent: null };
const email = () => `ended-${Math.random().toString(36).slice(2)}@example.test`;

describe('an ended pass before the first sign-in', () => {
  it.each([
    ['voided', "UPDATE passes SET status = 'voided' WHERE id = ?"],
    ['removed', 'UPDATE passes SET removed_at = 1 WHERE id = ?'],
  ])('attaches a %s pass to the signing-in holder', async (_, sql) => {
    const kit = await setupKit();
    const e = email();
    const live = await kit.pass({ holderEmail: e });
    const ended = await kit.pass({ holderEmail: e });
    await run(kit.env.DB, sql, [ended.id]);
    const result = await signInMagicLink(jobCtxOf(kit), e, sign);
    expect((await getPass(kit.env.DB, live.id))?.ownerUserId).toBe(result.userId);
    expect((await getPass(kit.env.DB, ended.id))?.ownerUserId).toBe(result.userId);
  });
});
