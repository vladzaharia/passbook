import { beforeAll, describe, expect, it } from 'vitest';
import { makeUser } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { enqueuePassEmail } from '../delivery/issuance-intent.ts';
import { handleEmailSend } from '../delivery/jobs.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import { resolveCaptureSnapshot } from './binding.ts';
import { getCapturedReference } from './repo-capture.ts';
import { finishForward, reserveForward } from './repo-forward.ts';
import { inboxAuthority, inboxMember } from './test-tenant-fixtures.ts';

let kit: Kit;

beforeAll(async () => {
  kit = await setupKit();
});

/** A reserved forward for a fresh member; `finishForward` runs on the request's own context (not a job). */
async function reserved() {
  const user = await makeUser(kit.fx);
  const member = await inboxMember(kit, user.id, kit.org.id, 'org_admin');
  const to = `${kit.ctx.ids.token(8).toLowerCase()}@example.com`;
  const pass = await kit.pass({ mode: 'test', memberName: 'Finish', holderEmail: to });
  const { outboxId } = await enqueuePassEmail(jobCtxOf(kit), {
    passId: pass.id,
    to,
    attach: false,
    expected: pass,
  });
  await handleEmailSend({ kind: 'email.send', outboxId }, jobCtxOf(kit));
  const cap = await first<{ id: string }>(
    kit.env.DB,
    'SELECT id FROM captured_emails WHERE outbox_id = ?',
    [outboxId],
  );
  if (!cap) throw new Error('capture missing');
  const authority = await inboxAuthority(kit, member.session);
  const ref = await getCapturedReference(kit.env.DB, cap.id, authority, kit.clock.now());
  const snapshot = ref ? await resolveCaptureSnapshot(kit.env.DB, ref) : null;
  if (!ref || !snapshot) throw new Error('reference missing');
  const id = kit.fx.ids.id();
  expect(await reserveForward(jobCtxOf(kit), id, ref, snapshot, authority, user.primaryEmail)).toBe(
    true,
  );
  const userRevision = authority.userAccessRevision ?? 0;
  return { id, authority, user, member, userRevision };
}

const stateOf = (id: string) =>
  first<{ state: string }>(kit.env.DB, 'SELECT state FROM sandbox_forwards WHERE id = ?', [id]);

describe('forward finish under a request-context deferred principal', () => {
  it('settles after the owner signed out (positive control)', async () => {
    const r = await reserved();
    await run(kit.env.DB, 'UPDATE sessions SET revoked_at = ? WHERE user_id = ?', [
      kit.clock.now(),
      r.user.id,
    ]);
    expect(await finishForward(kit.ctx, r.id, r.authority, 'sent', r.userRevision)).toBe(true);
    expect(await stateOf(r.id)).toEqual({ state: 'sent' });
  });

  it('refuses after the membership was revoked', async () => {
    const r = await reserved();
    await run(kit.env.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
      kit.clock.now(),
      r.member.membershipId,
    ]);
    expect(await finishForward(kit.ctx, r.id, r.authority, 'sent', r.userRevision)).toBe(false);
    expect(await stateOf(r.id)).toEqual({ state: 'sending' });
  });

  it('refuses after the org access revision moved', async () => {
    const r = await reserved();
    await run(kit.env.DB, 'UPDATE orgs SET access_revision = access_revision + 1 WHERE id = ?', [
      kit.org.id,
    ]);
    expect(await finishForward(kit.ctx, r.id, r.authority, 'sent', r.userRevision)).toBe(false);
    expect(await stateOf(r.id)).toEqual({ state: 'sending' });
  });

  it('refuses after the user access revision moved', async () => {
    const r = await reserved();
    await run(kit.env.DB, 'UPDATE users SET access_revision = access_revision + 1 WHERE id = ?', [
      r.user.id,
    ]);
    expect(await finishForward(kit.ctx, r.id, r.authority, 'sent', r.userRevision)).toBe(false);
    expect(await stateOf(r.id)).toEqual({ state: 'sending' });
  });
});
