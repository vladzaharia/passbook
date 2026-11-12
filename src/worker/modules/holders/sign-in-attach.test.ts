// Sign-in, email verification and an admin adding an address attach waiting passes, but never fail on one.
import { describe, expect, it, vi } from 'vitest';
import { makeUser } from '../../../../test/helpers/index.ts';
import { all, first, run } from '../../platform/db.ts';
import { signInMagicLink, verifyEmailForUser } from '../auth/service.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { addVerifiedEmail } from '../users/emails.ts';
import { INLINE_ATTACH_CAP } from './service-attach.ts';
import { resumeVerifiedHolderAttachments } from './transfer-jobs.ts';

const sign = { ipPrefix: null, userAgent: null };
const email = () => `sign-in-${Math.random().toString(36).slice(2)}@example.test`;
const owner = async (kit: Kit, passId: string) =>
  (await getPass(kit.env.DB, passId))?.ownerUserId ?? null;

/** A pre-cutover pass (no issued release) on an archived template: its transfer cannot build. */
async function unbuildable(kit: Kit, holderEmail: string) {
  const pass = await kit.pass({ holderEmail });
  await run(kit.env.DB, 'UPDATE passes SET release_id = NULL WHERE id = ?', [pass.id]);
  await run(kit.env.DB, "UPDATE templates SET status = 'archived' WHERE id = ?", [kit.template.id]);
  return pass;
}

describe('a waiting pass that cannot attach', () => {
  it('magic-link sign-in still starts a session; the bad pass stays waiting, the good one attaches', async () => {
    const kit = await setupKit();
    const e = email();
    const good = await kit.pass({ holderEmail: e });
    const bad = await unbuildable(kit, e);
    const ctx = jobCtxOf(kit);
    const warn = vi.spyOn(ctx.log, 'warn');
    const result = await signInMagicLink(ctx, e, sign);
    expect(warn).toHaveBeenCalledWith(
      'holder.attach_deferred',
      expect.objectContaining({ passId: bad.id, code: 'TEMPLATE_RELEASE_REQUIRED' }),
    );
    expect(result.session).toBeDefined();
    expect(
      await first(kit.env.DB, 'SELECT 1 AS ok FROM sessions WHERE user_id = ?', [result.userId]),
    ).toEqual({ ok: 1 });
    expect(await owner(kit, good.id)).toBe(result.userId);
    expect(await getPass(kit.env.DB, bad.id)).toMatchObject({ ownerUserId: null, holderEmail: e });
  }, 120_000);

  it('verifying an address completes; the bad pass stays waiting', async () => {
    const kit = await setupKit();
    const e = email();
    const bad = await unbuildable(kit, e);
    const user = await makeUser(kit.fx);
    await expect(verifyEmailForUser(jobCtxOf(kit), user.id, e)).resolves.toBeUndefined();
    expect(
      await first(kit.env.DB, 'SELECT 1 AS ok FROM user_emails WHERE user_id = ? AND email = ?', [
        user.id,
        e,
      ]),
    ).toEqual({ ok: 1 });
    expect(await owner(kit, bad.id)).toBeNull();
  }, 120_000);
});

describe('more waiting passes than the inline cap', () => {
  it('signs in after attaching the cap; the sweep attaches the rest', async () => {
    const kit = await setupKit();
    const e = email();
    const passes = await Promise.all(
      Array.from({ length: INLINE_ATTACH_CAP + 2 }, () => kit.pass({ holderEmail: e })),
    );
    const result = await signInMagicLink(jobCtxOf(kit), e, sign);
    const owned = async () =>
      (await Promise.all(passes.map((p) => owner(kit, p.id)))).filter((o) => o === result.userId)
        .length;
    expect(await owned()).toBe(INLINE_ATTACH_CAP);
    // The sweep pages the whole table with a cursor; other files' rows may come first.
    for (let i = 0; i < 5 && (await owned()) < passes.length; i++)
      await resumeVerifiedHolderAttachments(jobCtxOf(kit));
    expect(await owned()).toBe(passes.length);
  }, 120_000);
});

describe('an admin adds a verified address', () => {
  it('audits the attach as the admin, naming the owner in the detail', async () => {
    const kit = await setupKit();
    const e = email();
    const pass = await kit.pass({ holderEmail: e });
    const [admin, user] = await Promise.all([makeUser(kit.fx), makeUser(kit.fx)]);
    await addVerifiedEmail(jobCtxOf(kit), admin.id, user.id, e);
    expect(await owner(kit, pass.id)).toBe(user.id);
    const rows = await all<{ actor_type: string; actor_id: string; detail: string }>(
      kit.env.DB,
      "SELECT actor_type, actor_id, detail FROM audit_log WHERE action = 'holder.attach' AND target_id = ?",
      [pass.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_type: 'user', actor_id: admin.id });
    expect(JSON.parse(rows[0]?.detail ?? '{}')).toMatchObject({ userId: user.id });
  }, 120_000);

  it('a self-verified address is audited as the owner', async () => {
    const kit = await setupKit();
    const e = email();
    const pass = await kit.pass({ holderEmail: e });
    const user = await makeUser(kit.fx);
    await verifyEmailForUser(jobCtxOf(kit), user.id, e);
    expect(
      await first(
        kit.env.DB,
        "SELECT actor_id FROM audit_log WHERE action = 'holder.attach' AND target_id = ?",
        [pass.id],
      ),
    ).toEqual({ actor_id: user.id });
  }, 120_000);
});
