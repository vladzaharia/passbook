import { beforeAll, describe, expect, it } from 'vitest';
import { renderPassEmail } from '../../email/pass.ts';
import { deleteInBatches } from '../../platform/batched.ts';
import { all, first, run } from '../../platform/db.ts';
import { purgeLogs } from '../apple/repo.ts';
import { type Kit, setupKit } from '../passes/test-kit.ts';
import { createMtlsApnsTransport } from './apns.ts';
import { handleEmailSend, handlePushDeliver, sweepDelivery } from './jobs.ts';
import { classifyApns } from './push.ts';
import { dropRegistrations, failExhausted, getOutbox } from './repo.ts';
import { EMAIL_RECIPIENT_HOURLY_CAP, enqueuePassEmail, enqueuePush } from './service.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await setupKit();
});

let seq = 0;
const address = () => `holder${++seq}@example.com`;

async function emailFor(pass: { id: string }, to = address(), attach = false) {
  const { outboxId } = await enqueuePassEmail(kit.ctx, { passId: pass.id, to, attach });
  return outboxId;
}

async function pushRow(passId: string) {
  return (
    (
      await first<{ id: string }>(
        kit.env.DB,
        "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'push' ORDER BY created_at DESC LIMIT 1",
        [passId],
      )
    )?.id ?? ''
  );
}

function captureEvents(): { points: { blobs: string[] }[]; stop(): void } {
  const points: { blobs: string[] }[] = [];
  (kit.env as unknown as Record<string, unknown>).EVENTS = {
    writeDataPoint: (p: { blobs: string[] }) => points.push(p),
  };
  return {
    points,
    stop: () => {
      (kit.env as unknown as Record<string, unknown>).EVENTS = undefined;
    },
  };
}

describe('email.result events', () => {
  it('writes ok after a send and failed after a failed attempt', async () => {
    const events = captureEvents();
    try {
      const pass = await kit.pass();
      const id = await emailFor(pass);
      await handleEmailSend({ kind: 'email.send', outboxId: id }, kit.ctx);
      kit.mailer.fail = new Error('down');
      const retry = await emailFor(pass);
      await expect(
        handleEmailSend({ kind: 'email.send', outboxId: retry }, kit.ctx),
      ).rejects.toMatchObject({ code: 'EMAIL_FAILED' });
      kit.mailer.fail = null;
      const results = events.points
        .filter((p) => p.blobs[0] === 'email.result')
        .map((p) => [p.blobs[1], p.blobs[4]]);
      expect(results).toEqual([
        [pass.orgId, 'ok'],
        [pass.orgId, 'failed'],
      ]);
    } finally {
      kit.mailer.fail = null;
      events.stop();
    }
  });
});

describe('email content', () => {
  it('uses the support contacts; the band is page-tone, not the accent', async () => {
    await run(kit.env.DB, 'UPDATE orgs SET branding = ? WHERE id = ?', [
      JSON.stringify({
        accent: '#123abc',
        supportEmail: 'help@gym.test',
        supportUrl: 'https://gym.test/help',
      }),
      kit.org.id,
    ]);
    const pass = await kit.pass();
    await handleEmailSend({ kind: 'email.send', outboxId: await emailFor(pass) }, kit.ctx);
    const sent = kit.mailer.sent.at(-1);
    expect(sent?.html).not.toContain('#123abc');
    expect(sent?.html).toContain('help@gym.test');
    expect(sent?.html).toContain('https://gym.test/help');
    expect(sent?.text).toContain('help@gym.test');
    await run(kit.env.DB, "UPDATE orgs SET branding = '{}' WHERE id = ?", [kit.org.id]);
  });

  it('escapes support contacts and drops unsafe urls', () => {
    const email = renderPassEmail({
      orgName: 'Gym',
      supportEmail: 'a"b@x.test',
      supportUrl: 'javascript:alert(1)',
      downloadUrl: 'https://w.test/p/t/pass.pkpass',
      manageUrl: 'https://w.test/p/t',
      badgeUrl: 'https://w.test/b.png',
      attached: false,
    });
    expect(email.html).not.toContain('javascript:');
    expect(email.html).not.toContain('a"b@x.test');
    expect(email.html).not.toContain('Questions');
  });
});

describe('email delivery', () => {
  it('does not send again when the row cannot be finished after a successful send', async () => {
    const pass = await kit.pass();
    const id = await emailFor(pass);
    await run(
      kit.env.DB,
      `CREATE TRIGGER fail_finish BEFORE UPDATE ON outbox WHEN NEW.state = 'sent'
       BEGIN SELECT RAISE(ABORT, 'boom'); END`,
    );
    const before = kit.mailer.sent.length;
    try {
      await handleEmailSend({ kind: 'email.send', outboxId: id }, kit.ctx);
    } finally {
      await run(kit.env.DB, 'DROP TRIGGER fail_finish');
    }
    expect(kit.mailer.sent.length).toBe(before + 1);
    expect(await getOutbox(kit.env.DB, id)).toMatchObject({ state: 'processing' });
    // Lease expires; the sweeper hands the row back and the re-run only finishes it.
    kit.clock.advance(10 * 60_000);
    await sweepDelivery(kit.ctx);
    await handleEmailSend({ kind: 'email.send', outboxId: id }, kit.ctx);
    expect(kit.mailer.sent.length).toBe(before + 1);
    expect(await getOutbox(kit.env.DB, id)).toMatchObject({ state: 'sent' });
  });

  it('fails a missing pass object at once instead of retrying', async () => {
    const pass = await kit.pass();
    const id = await emailFor(pass, address(), true);
    await kit.env.BUCKET.delete(pass.objectKey);
    await handleEmailSend({ kind: 'email.send', outboxId: id }, kit.ctx);
    expect(await getOutbox(kit.env.DB, id)).toMatchObject({
      state: 'failed',
      errorCode: 'EMAIL_PERMANENT',
      attempts: 1,
    });
  });

  it('cancels mail and pushes of a suspended org', async () => {
    const pass = await kit.pass();
    await kit.device(pass, `dev-s-${pass.id}`, 'e'.repeat(64));
    const id = await emailFor(pass);
    await enqueuePush(kit.ctx, pass.id, 'refresh');
    await kit.settle();
    const push = await pushRow(pass.id);
    await run(kit.env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [pass.orgId]);
    const sent = kit.mailer.sent.length;
    const pushed = kit.apns.sent.length;
    await handleEmailSend({ kind: 'email.send', outboxId: id }, kit.ctx);
    await handlePushDeliver({ kind: 'push.deliver', outboxId: push }, kit.ctx);
    await run(kit.env.DB, "UPDATE orgs SET status = 'active' WHERE id = ?", [pass.orgId]);
    expect(kit.mailer.sent.length).toBe(sent);
    expect(kit.apns.sent.length).toBe(pushed);
    expect(await getOutbox(kit.env.DB, id)).toMatchObject({
      state: 'cancelled',
      errorCode: 'ORG_INACTIVE',
    });
    expect(await getOutbox(kit.env.DB, push)).toMatchObject({
      state: 'cancelled',
      errorCode: 'ORG_INACTIVE',
    });
  });
});

describe('email caps', () => {
  it('limits one recipient per hour and keeps other recipients unaffected', async () => {
    const pass = await kit.pass();
    const to = address();
    for (let i = 0; i < EMAIL_RECIPIENT_HOURLY_CAP; i++) await emailFor(pass, to);
    await expect(emailFor(pass, to.toUpperCase())).rejects.toMatchObject({
      code: 'EMAIL_RATE_LIMITED',
      status: 429,
    });
    await expect(emailFor(pass, address())).resolves.toBeTruthy();
    kit.clock.advance(61 * 60_000);
    await expect(emailFor(pass, to)).resolves.toBeTruthy();
  });
});

describe('outbox claims', () => {
  it('fails a row only when its attempts are used up', async () => {
    const pass = await kit.pass();
    await enqueuePush(kit.ctx, pass.id, 'refresh');
    await kit.settle();
    const id = await pushRow(pass.id);
    await run(
      kit.env.DB,
      "UPDATE outbox SET state = 'enqueued', attempts = 1, max_attempts = 8 WHERE id = ?",
      [id],
    );
    expect(await failExhausted(kit.env.DB, id, kit.clock.now())).toBe(false);
    expect(await getOutbox(kit.env.DB, id)).toMatchObject({ state: 'enqueued' });
    await run(kit.env.DB, 'UPDATE outbox SET attempts = 8 WHERE id = ?', [id]);
    expect(await failExhausted(kit.env.DB, id, kit.clock.now())).toBe(true);
    expect(await getOutbox(kit.env.DB, id)).toMatchObject({
      state: 'failed',
      errorCode: 'MAX_ATTEMPTS',
    });
  });
});

describe('dead tokens', () => {
  it('removes every registration of the device that holds the dead token', async () => {
    const one = await kit.pass();
    const two = await kit.pass();
    await kit.device(one, 'dead-dev', 'f'.repeat(64));
    await kit.device(two, 'dead-dev', 'f'.repeat(64));
    await dropRegistrations(kit.env.DB, one.identityId, [
      { deviceId: 'dead-dev', pushToken: 'f'.repeat(64) },
    ]);
    const left = await first(
      kit.env.DB,
      "SELECT 1 FROM registrations WHERE device_id = 'dead-dev'",
    );
    const device = await first(kit.env.DB, "SELECT 1 FROM devices WHERE device_id = 'dead-dev'");
    expect(left).toBeNull();
    expect(device).toBeNull();
  });
});

describe('dead tokens on a shared device', () => {
  it('keeps registrations that hold a different token', async () => {
    const mine = await kit.pass();
    const other = await kit.pass();
    await kit.device(mine, 'shared-dev', 'a'.repeat(64));
    await kit.device(other, 'shared-dev', 'b'.repeat(64));
    await dropRegistrations(kit.env.DB, mine.identityId, [
      { deviceId: 'shared-dev', pushToken: 'b'.repeat(64) },
    ]);
    const left = await all<{ pass_id: string }>(
      kit.env.DB,
      "SELECT pass_id FROM registrations WHERE device_id = 'shared-dev'",
    );
    expect(left.map((r) => r.pass_id)).toEqual([mine.id]);
    expect(
      await first(kit.env.DB, "SELECT 1 FROM devices WHERE device_id = 'shared-dev'"),
    ).not.toBeNull();
  });
});

describe('batched retention', () => {
  const seed = async (n: number, at: number) => {
    for (let i = 0; i < n; i += 500) {
      const rows = Math.min(500, n - i);
      await run(
        kit.env.DB,
        `WITH RECURSIVE seq(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM seq WHERE x < ?)
         INSERT INTO wallet_logs (at, line) SELECT ?, 'l' FROM seq`,
        [rows, at],
      );
    }
  };
  const count = async () =>
    (await first<{ n: number }>(kit.env.DB, 'SELECT count(*) AS n FROM wallet_logs'))?.n ?? 0;

  it('deletes at most 1000 rows per statement and loops up to its cap', async () => {
    await run(kit.env.DB, 'DELETE FROM wallet_logs');
    await seed(2500, 1);
    expect(await deleteInBatches(kit.env.DB, 'wallet_logs', 'at < ?', [10], 1)).toBe(1000);
    expect(await count()).toBe(1500);
    expect(await purgeLogs(kit.env.DB, 10)).toBe(1500);
    expect(await count()).toBe(0);
  });
});

describe('APNs transport', () => {
  const A = 'a'.repeat(64);
  const target = { passTypeIdentifier: 'pass.test', apnsBinding: 'APNS' };
  const transport = (handler: () => Promise<Response>) =>
    createMtlsApnsTransport({
      ...kit.env,
      APNS: { fetch: handler } as unknown as Fetcher,
    });

  it('reads the reason of a 400 and classifies a dead token', async () => {
    const [r] = await transport(
      async () => new Response('{"reason":"BadDeviceToken"}', { status: 400 }),
    ).send(target, [A], 0);
    expect(r).toEqual({ token: A, status: 400, reason: 'BadDeviceToken' });
    expect(r && classifyApns(r)).toBe('gone');
  });

  it('reads the reason of a 410', async () => {
    const [r] = await transport(
      async () => new Response('{"reason":"Unregistered"}', { status: 410 }),
    ).send(target, [A], 0);
    expect(r).toEqual({ token: A, status: 410, reason: 'Unregistered' });
    expect(r && classifyApns(r)).toBe('gone');
  });

  it('maps a thrown fetch to NetworkError', async () => {
    const [r] = await transport(async () => {
      throw new Error('boom');
    }).send(target, [A], 0);
    expect(r).toEqual({ token: A, status: 0, reason: 'NetworkError:Error' });
    expect(r && classifyApns(r)).toBe('transient');
  });

  it('is unavailable without the binding and refuses every token', async () => {
    const t = createMtlsApnsTransport({ ...kit.env });
    const missing = { passTypeIdentifier: 'pass.test', apnsBinding: 'MISSING' };
    expect(t.isAvailable(missing)).toBe(false);
    expect(await t.send(missing, [A, 'b'.repeat(64)], 0)).toEqual([
      { token: A, status: 0, reason: 'PushUnavailable' },
      { token: 'b'.repeat(64), status: 0, reason: 'PushUnavailable' },
    ]);
  });

  it('returns a status without a reason for a non-JSON 500', async () => {
    const [r] = await transport(
      async () => new Response('<html>oops</html>', { status: 500 }),
    ).send(target, [A], 0);
    expect(r).toEqual({ token: A, status: 500 });
    expect(r && classifyApns(r)).toBe('transient');
  });
});
