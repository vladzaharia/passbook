import type { OpenAPIHono } from '@hono/zod-openapi';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { makeUser, type SessionFixture } from '../../../../test/helpers/index.ts';
import {
  CapturedEmailDetailSchema,
  CapturedEmailListSchema,
} from '../../../shared/contracts/index.ts';
import type { AppBindings } from '../../platform/context.ts';
import { all, first, run } from '../../platform/db.ts';
import { fakeLimiter } from '../auth/test-support.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { enqueuePassEmail } from '../delivery/issuance-intent.ts';
import { handleEmailSend } from '../delivery/jobs.ts';
import { reassignHolder } from '../holders/service.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import { resolveCaptureSnapshot } from './binding.ts';
import { getCapturedReference } from './repo-capture.ts';
import {
  expireStaleForwards,
  FORWARD_LEASE_MS,
  finishForward,
  reserveForward,
  UNKNOWN_FORWARD_MS,
} from './repo-forward.ts';
import { sendCapturedToMe } from './service.ts';
import {
  inboxApp,
  inboxAuthority,
  inboxHeaders,
  inboxMember,
  scopedInboxPath,
} from './test-tenant-fixtures.ts';

const ORIGIN = 'https://wallet.test';
let kit: Kit;
let app: OpenAPIHono<AppBindings>;

beforeAll(async () => {
  kit = await setupKit();
  kit.env.RL_REFRESH = fakeLimiter(1000) as unknown as RateLimit;
  app = inboxApp(kit);
});

const uniqueEmail = () => `${kit.ctx.ids.token(8).toLowerCase()}@example.com`;

async function operator() {
  const user = await makeUser(kit.fx);
  const { session, membershipId } = await inboxMember(kit, user.id, kit.org.id, 'org_admin');
  return { user, session, membershipId };
}

const api = (path: string, session: SessionFixture, method = 'GET') =>
  app.request(
    `${ORIGIN}/api/v1${scopedInboxPath(path, kit.org.id)}`,
    { method, headers: inboxHeaders(session) },
    kit.env,
  );

/** Queue a Test email for a fresh pass; `by` is the authority the mail acts for (default: system). */
async function queue(by?: Awaited<ReturnType<typeof inboxAuthority>>) {
  const to = uniqueEmail();
  const pass = await kit.pass({ mode: 'test', memberName: 'Lifecycle', holderEmail: to });
  const { outboxId } = await enqueuePassEmail(by ? jobCtxOf(kit) : jobCtxOf(kit), {
    passId: pass.id,
    to,
    attach: false,
    expected: pass,
    ...(by ? { authority: by } : {}),
  });
  return { pass, to, outboxId };
}

const send = (outboxId: string) => handleEmailSend({ kind: 'email.send', outboxId }, jobCtxOf(kit));
const outbox = (id: string) =>
  first<{ state: string; error_code: string | null }>(
    kit.env.DB,
    'SELECT state, error_code FROM outbox WHERE id = ?',
    [id],
  );
const captures = (id: string) =>
  all(kit.env.DB, 'SELECT id FROM captured_emails WHERE outbox_id = ?', [id]);

async function capture() {
  const q = await queue();
  await send(q.outboxId);
  const row = await first<{ id: string }>(
    kit.env.DB,
    'SELECT id FROM captured_emails WHERE outbox_id = ?',
    [q.outboxId],
  );
  if (!row) throw new Error('capture missing');
  return { ...q, id: row.id };
}

async function reservation(captureId: string, actor: Awaited<ReturnType<typeof operator>>) {
  const authority = await inboxAuthority(kit, actor.session);
  const ref = await getCapturedReference(kit.env.DB, captureId, authority, kit.clock.now());
  if (!ref) throw new Error('ref missing');
  const snapshot = await resolveCaptureSnapshot(kit.env.DB, ref);
  if (!snapshot) throw new Error('snapshot missing');
  const id = kit.fx.ids.id();
  const ok = await reserveForward(
    jobCtxOf(kit),
    id,
    ref,
    snapshot,
    authority,
    actor.user.primaryEmail,
  );
  return { id, ok, authority };
}

describe('capture authority at output', () => {
  it('captures after the initiator signed out and the session expired', async () => {
    const actor = await operator();
    const authority = await inboxAuthority(kit, actor.session);
    const q = await queue(authority);
    await run(kit.env.DB, 'UPDATE sessions SET revoked_at = ? WHERE user_id = ?', [
      kit.clock.now(),
      actor.user.id,
    ]);
    await send(q.outboxId);
    expect(await outbox(q.outboxId)).toMatchObject({ state: 'sent', error_code: 'TEST_MODE' });
    expect(await captures(q.outboxId)).toHaveLength(1);
  });

  it('stores nothing after a revoked membership or a disabled user', async () => {
    const revoked = await operator();
    const a = await queue(await inboxAuthority(kit, revoked.session));
    await run(kit.env.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
      kit.clock.now(),
      revoked.membershipId,
    ]);
    await send(a.outboxId);
    expect(await outbox(a.outboxId)).toMatchObject({
      state: 'cancelled',
      error_code: 'ACTOR_REVOKED',
    });
    expect(await captures(a.outboxId)).toEqual([]);

    const disabled = await operator();
    const b = await queue(await inboxAuthority(kit, disabled.session));
    await run(kit.env.DB, "UPDATE users SET status = 'disabled' WHERE id = ?", [disabled.user.id]);
    await send(b.outboxId);
    expect(await outbox(b.outboxId)).toMatchObject({
      state: 'cancelled',
      error_code: 'ACTOR_REVOKED',
    });
    expect(await captures(b.outboxId)).toEqual([]);
  });

  it('stores nothing for a quarantined pass', async () => {
    const q = await queue();
    await run(kit.env.DB, 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', [q.pass.id]);
    await send(q.outboxId);
    expect(await outbox(q.outboxId)).toMatchObject({ state: 'cancelled' });
    expect(await captures(q.outboxId)).toEqual([]);
  });
});

describe('visibility and old captures', () => {
  it('lists and reads a capture whose pass has since moved on; sending is refused', async () => {
    const actor = await operator();
    const c = await capture();
    await reassignHolder(
      jobCtxOf(kit),
      { type: 'system', id: null },
      { passId: c.pass.id, email: uniqueEmail() },
      null,
    );
    const list = CapturedEmailListSchema.parse(
      await (await api('/test-inbox', actor.session)).json(),
    );
    expect(list.items.map((i) => i.id)).toContain(c.id);
    const detail = await api(`/test-inbox/${c.id}`, actor.session);
    expect(detail.status).toBe(200);
    expect(CapturedEmailDetailSchema.parse(await detail.json())).toMatchObject({
      id: c.id,
      to: c.to,
      forwarding: 'none',
    });
    const sent = await api(`/test-inbox/${c.id}/send-to-me`, actor.session, 'POST');
    expect(sent.status).toBe(409);
    expect(await sent.json()).toMatchObject({ code: 'TEST_FORWARD_CHANGED' });
  });

  it('pages in one bounded query however many captures have changed', async () => {
    const actor = await operator();
    const made = [await capture(), await capture(), await capture()];
    await run(kit.env.DB, 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', [
      made[1]?.pass.id ?? '',
    ]);
    const response = await api('/test-inbox?limit=2', actor.session);
    const page = CapturedEmailListSchema.parse(await response.json());
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
  });
});

describe('forwarding reservations', () => {
  it('allows another send after a sent one', async () => {
    const actor = await operator();
    const c = await capture();
    const first = await api(`/test-inbox/${c.id}/send-to-me`, actor.session, 'POST');
    expect(first.status).toBe(200);
    const second = await api(`/test-inbox/${c.id}/send-to-me`, actor.session, 'POST');
    expect(second.status).toBe(200);
    const states = await all<{ state: string }>(
      kit.env.DB,
      'SELECT state FROM sandbox_forwards WHERE capture_id = ? ORDER BY rowid',
      [c.id],
    );
    expect(states.map((s) => s.state)).toEqual(['sent', 'sent']);
  });

  it('logs a mailer error with a stable code and leaves the outcome unknown', async () => {
    const actor = await operator();
    const c = await capture();
    const warn = vi.spyOn(kit.ctx.log, 'warn');
    vi.spyOn(kit.mailer, 'send').mockRejectedValueOnce(new TypeError('boom a@b.example'));
    await expect(
      sendCapturedToMe(jobCtxOf(kit), await inboxAuthority(kit, actor.session), c.id),
    ).rejects.toMatchObject({ code: 'TEST_FORWARD_OUTCOME_UNKNOWN' });
    const call = warn.mock.calls.find(([event]) => event === 'sandbox.forward_mailer_failed');
    expect(call?.[1]).toEqual({ code: 'TEST_FORWARD_MAILER', reason: 'TypeError' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('b.example');
    expect(
      await first(kit.env.DB, 'SELECT state FROM sandbox_forwards WHERE capture_id = ?', [c.id]),
    ).toEqual({ state: 'unknown' });
  });

  it('expires a sending reservation past its lease; org suspension is never blocked', async () => {
    // Earlier tests leave live reservations in this org.
    kit.clock.advance(UNKNOWN_FORWARD_MS + FORWARD_LEASE_MS);
    await expireStaleForwards(jobCtxOf(kit));
    const actor = await operator();
    const c = await capture();
    const r = await reservation(c.id, actor);
    expect(r.ok).toBe(true);
    // A suspension is a kill switch: a live `sending` reservation does not hold it.
    await run(kit.env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [kit.org.id]);
    await run(kit.env.DB, "UPDATE orgs SET status = 'active' WHERE id = ?", [kit.org.id]);
    kit.clock.advance(FORWARD_LEASE_MS + 1);
    await expireStaleForwards(jobCtxOf(kit));
    expect(
      await first(kit.env.DB, 'SELECT state FROM sandbox_forwards WHERE id = ?', [r.id]),
    ).toEqual({ state: 'expired' });
  });

  it('expires an unknown outcome after a day; disabling the user is never blocked', async () => {
    const actor = await operator();
    const c = await capture();
    const r = await reservation(c.id, actor);
    expect(
      await finishForward(
        jobCtxOf(kit),
        r.id,
        r.authority,
        'unknown',
        r.authority.userAccessRevision ?? 0,
      ),
    ).toBe(true);
    await run(kit.env.DB, "UPDATE users SET status = 'disabled' WHERE id = ?", [actor.user.id]);
    await run(kit.env.DB, "UPDATE users SET status = 'active' WHERE id = ?", [actor.user.id]);
    kit.clock.advance(UNKNOWN_FORWARD_MS - 1000);
    await expireStaleForwards(jobCtxOf(kit));
    expect(
      await first(kit.env.DB, 'SELECT state FROM sandbox_forwards WHERE id = ?', [r.id]),
    ).toEqual({ state: 'unknown' });
    kit.clock.advance(2000);
    await expireStaleForwards(jobCtxOf(kit));
    expect(
      await first(kit.env.DB, 'SELECT state FROM sandbox_forwards WHERE id = ?', [r.id]),
    ).toEqual({ state: 'expired' });
    const again = await reservation(c.id, await operator());
    expect(again.ok).toBe(true);
  });

  it('reserves again at once when the earlier lease has passed', async () => {
    const actor = await operator();
    const c = await capture();
    expect((await reservation(c.id, actor)).ok).toBe(true);
    expect((await reservation(c.id, actor)).ok).toBe(false);
    kit.clock.advance(FORWARD_LEASE_MS + 1);
    expect((await reservation(c.id, actor)).ok).toBe(true);
  });
});
