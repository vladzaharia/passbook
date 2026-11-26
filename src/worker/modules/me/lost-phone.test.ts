import { describe, expect, it, vi } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { runJob } from '../../jobs/registry.ts';
import type { Job } from '../../jobs/types.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { all, first, run } from '../../platform/db.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { fakeLimiter } from '../auth/test-support.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { EMAIL_RECIPIENT_HOURLY_CAP } from '../delivery/issuance-intent.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { codeOf, key, ORIGIN, setupScanKit } from '../scan/test-kit.ts';

async function setup() {
  const kit = await setupScanKit();
  const queued: Job[] = [];
  kit.env.JOBS = {
    send: vi.fn(async (job: Job) => void queued.push(job)),
    sendBatch: vi.fn(),
  } as unknown as Queue;
  kit.env.RL_REFRESH = fakeLimiter(1000) as unknown as RateLimit;
  const templateId = await kit.scanTemplate('Lost phone', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
  });
  const user = await makeUser(kit.fx);
  const stranger = await makeUser(kit.fx);
  const pass = await kit.scanPass(templateId, {}, { holderEmail: user.primaryEmail });
  const theirs = await kit.scanPass(templateId, {}, { holderEmail: stranger.primaryEmail });
  const mine = await makeSession(kit.fx, { userId: user.id, amr: 'magic_link' });
  const app = createApp({
    clock: kit.clock,
    stores: { ...denyAllStores, sessions: createSessionStore(kit.env, kit.clock) },
  });
  const post = (path: string, headers = mine.headers) =>
    Promise.resolve(
      app.request(`${ORIGIN}/api/v1/me${path}`, { method: 'POST', headers }, kit.env),
    );
  const mails = (passId: string) =>
    all(kit.env.DB, "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'email'", [passId]);
  /** Runs what the request queued, as the queue consumer would. */
  const drain = async () => {
    for (const job of queued.splice(0))
      if (job.kind === 'pass.holder_mail') await runJob(job, jobCtxOf(kit));
  };
  const lostPhone = await makeSession(kit.fx, { userId: user.id, amr: 'magic_link' });
  return { lostPhone, mine, drain, queued, kit, templateId, user, pass, theirs, post, mails };
}

describe('I lost my phone', () => {
  it('mints a new code and link, the old code is refused at the door, the pass is sent again, audited', async () => {
    const { kit, pass, post, mails, user, drain } = await setup();
    const scanner = await kit.scanner({ templateIds: [pass.templateId] });
    const scan = (code: string) =>
      kit.post(scanner.headers, '/resolve', {
        idempotencyKey: key(),
        input: { code, method: 'camera' },
        clientTs: kit.clock.now(),
      });
    expect(await (await scan(codeOf(pass).code)).json()).toMatchObject({ kind: 'ready' });
    const before = (await mails(pass.id)).length;
    const res = await post(`/passes/${pass.id}/lost-phone`);
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ state: 'completed' });
    const after = await getPass(kit.env.DB, pass.id);
    expect(after?.scanCode).not.toBe(pass.scanCode);
    expect(after?.downloadToken).not.toBe(pass.downloadToken);
    expect(after?.ownerUserId).toBe(user.id);
    expect(after?.holderEmail).toBe(pass.holderEmail);
    await drain();
    const old = await (await scan(codeOf(pass).code)).json();
    expect(old).not.toMatchObject({ kind: 'ready' });
    expect(old).not.toMatchObject({ kind: 'ok' });
    expect((await mails(pass.id)).length).toBeGreaterThan(before);
    expect(
      await first(
        kit.env.DB,
        "SELECT 1 FROM audit_log WHERE action = 'holder.lost_phone' AND target_id = ?",
        [pass.id],
      ),
    ).not.toBeNull();
  });

  it("refuses another holder's pass", async () => {
    const { theirs, post, kit } = await setup();
    await expectProblem(await post(`/passes/${theirs.id}/lost-phone`), 404, 'PASS_NOT_FOUND');
    await expectProblem(await post(`/passes/${theirs.id}/resend`), 404, 'PASS_NOT_FOUND');
    expect((await getPass(kit.env.DB, theirs.id))?.scanCode).toBe(theirs.scanCode);
  });
});

describe('I lost my phone: sessions, bundles, limits', () => {
  it('signs out the other sessions, keeps this one and keeps the bundle', async () => {
    const { kit, pass, post, lostPhone, user } = await setup();
    const bundleId = kit.fx.ids.id();
    await run(
      kit.env.DB,
      "INSERT INTO bundles (id, org_id, name, token, created_at) VALUES (?, ?, 'B', ?, 1)",
      [bundleId, pass.orgId, `h1:${kit.fx.ids.token()}`],
    );
    await run(
      kit.env.DB,
      'INSERT INTO bundle_passes (bundle_id, pass_id, position) VALUES (?, ?, 0)',
      [bundleId, pass.id],
    );
    expect((await post(`/passes/${pass.id}/lost-phone`)).status).toBe(202);
    expect((await post(`/passes/${pass.id}/resend`, lostPhone.headers)).status).toBe(401);
    expect((await post(`/passes/${pass.id}/resend`)).status).toBe(202);
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM bundle_passes WHERE bundle_id = ? AND pass_id = ?', [
        bundleId,
        pass.id,
      ]),
    ).not.toBeNull();
    expect(
      await first(
        kit.env.DB,
        "SELECT 1 FROM audit_log WHERE action = 'user.sessions_revoke' AND target_id = ?",
        [user.id],
      ),
    ).not.toBeNull();
  });

  it('limits lost phone to 3 an hour per pass', async () => {
    const { pass, post } = await setup();
    for (let i = 0; i < 3; i++) {
      expect((await post(`/passes/${pass.id}/lost-phone`)).status).toBe(202);
    }
    await expectProblem(await post(`/passes/${pass.id}/lost-phone`), 429, 'RATE_LIMITED');
  });
});

describe('Send it again', () => {
  it('mails the holder and stops at the recipient cap', async () => {
    const { pass, post, mails, drain } = await setup();
    for (let i = 0; i < EMAIL_RECIPIENT_HOURLY_CAP; i++) {
      expect((await post(`/passes/${pass.id}/resend`)).status).toBe(202);
      await drain();
    }
    expect((await mails(pass.id)).length).toBe(EMAIL_RECIPIENT_HOURLY_CAP);
    await expectProblem(await post(`/passes/${pass.id}/resend`), 429, 'EMAIL_RATE_LIMITED');
  });
});
