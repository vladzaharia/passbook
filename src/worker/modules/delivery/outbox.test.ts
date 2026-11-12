import { beforeAll, describe, expect, it } from 'vitest';
import { renderPassEmail } from '../../email/pass.ts';
import { handleQueue } from '../../jobs/queue.ts';
import { retryDelaySeconds } from '../../jobs/retry.ts';
import { first, run } from '../../platform/db.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import { jobCtxOf } from './delivery-test-fixtures.ts';
import { enqueuePassEmail } from './issuance-intent.ts';
import { dailyDelivery, handleEmailSend, handlePushDeliver, sweepDelivery } from './jobs.ts';
import { getOutbox } from './repo.ts';
import { enqueuePush } from './service.ts';

const job = () => jobCtxOf(kit);

let kit: Kit;
beforeAll(async () => {
  kit = await setupKit();
});

const DAY = 86_400_000;

async function emailRow(passId: string) {
  return first<{ id: string }>(
    kit.env.DB,
    "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'email' ORDER BY created_at DESC, id DESC LIMIT 1",
    [passId],
  );
}

describe('pass email', () => {
  it('renders links, badge and a text part, escaping the organization name', () => {
    const email = renderPassEmail({
      orgName: 'A&B <Gym>',
      downloadUrl: 'https://w.test/p/t/pass.pkpass',
      manageUrl: 'https://w.test/p/t',
      badgeUrl: 'https://w.test/apple/add-to-apple-wallet.png',
      attached: true,
    });
    expect(email.subject).toBe('Your A&B <Gym> pass');
    expect(email.html).toContain('<html lang="en" ');
    expect(email.html).toContain('charset="utf-8"');
    expect(email.html).toContain('A&amp;B &lt;Gym&gt;');
    expect(email.html).toContain('href="https://w.test/p/t/pass.pkpass"');
    expect(email.html).toContain('alt="Add to Apple Wallet"');
    expect(email.text).toContain('Open your pass: https://w.test/p/t');
    expect(email.text).toContain('attached');
  });

  it('sends to the holder with direct links and an optional attachment', async () => {
    const pass = await kit.pass();
    const { outboxId } = await enqueuePassEmail(job(), {
      passId: pass.id,
      to: ' Holder@Example.com ',
      attach: true,
      expected: pass,
    });
    await kit.settle();
    expect(kit.queue.sent).toContainEqual({ kind: 'email.send', outboxId });
    await handleEmailSend({ kind: 'email.send', outboxId }, job());
    const sent = kit.mailer.sent.at(-1);
    expect(sent?.to).toBe('holder@example.com');
    expect(sent?.html).toContain(`/p/${pass.downloadToken}/pass.pkpass`);
    expect(sent?.html).toContain(`/p/${pass.downloadToken}"`);
    expect(sent?.attachments?.[0]).toMatchObject({ type: 'application/vnd.apple.pkpass' });
    expect(sent?.attachments?.[0]?.content.length).toBeGreaterThan(100);
    expect(await getOutbox(kit.env.DB, outboxId)).toMatchObject({ state: 'sent' });
  });

  it('omits the attachment by default', async () => {
    const pass = await kit.pass();
    const { outboxId } = await enqueuePassEmail(job(), {
      passId: pass.id,
      to: 'a@example.com',
      attach: false,
      expected: pass,
    });
    await handleEmailSend({ kind: 'email.send', outboxId }, job());
    expect(kit.mailer.sent.at(-1)?.attachments).toBeUndefined();
  });

  it('rejects an invalid recipient before queueing', async () => {
    const pass = await kit.pass();
    await expect(
      enqueuePassEmail(job(), {
        passId: pass.id,
        to: 'a@b.com,c@d.com',
        attach: false,
        expected: pass,
      }),
    ).rejects.toMatchObject({ code: 'EMAIL_INVALID' });
    expect(await emailRow(pass.id)).toBeNull();
  });

  it('keeps an ambiguous provider result unknown and never retries it automatically', async () => {
    const pass = await kit.pass();
    const { outboxId } = await enqueuePassEmail(job(), {
      passId: pass.id,
      to: 'a@example.com',
      attach: false,
      expected: pass,
    });
    kit.mailer.fail = new Error('smtp down');
    try {
      await handleEmailSend({ kind: 'email.send', outboxId }, job());
    } finally {
      kit.mailer.fail = null;
    }
    expect(await getOutbox(kit.env.DB, outboxId)).toMatchObject({
      state: 'partial',
      attempts: 1,
      errorCode: 'EMAIL_OUTCOME_UNKNOWN',
    });
    const before = kit.mailer.sent.length;
    await handleEmailSend({ kind: 'email.send', outboxId }, job());
    expect(kit.mailer.sent).toHaveLength(before);
    expect(await getOutbox(kit.env.DB, outboxId)).toMatchObject({ state: 'partial', attempts: 1 });
  });
});

describe('queue consumer contract', () => {
  function batch(body: unknown, attempts = 1) {
    const calls = { ack: 0, retry: [] as unknown[] };
    const message = {
      id: 'm1',
      body,
      attempts,
      ack: () => void calls.ack++,
      retry: (options: unknown) => void calls.retry.push(options),
    };
    return {
      calls,
      batch: { queue: 'wallet-jobs', messages: [message] } as unknown as MessageBatch<unknown>,
    };
  }
  const exec = {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;

  it('acks on success and retries with backoff when the handler throws', async () => {
    const pass = await kit.pass();
    await kit.device(pass, `dev-q-${pass.id}`, 'd'.repeat(64));
    await enqueuePush(job(), pass.id, 'refresh');
    await kit.settle();
    const row = await first<{ id: string }>(
      kit.env.DB,
      "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'push'",
      [pass.id],
    );

    kit.apns.results.set('d'.repeat(64), { status: 503 });
    const failing = batch({ kind: 'push.deliver', outboxId: row?.id });
    await handleQueue(failing.batch, kit.env, exec);
    expect(failing.calls.ack).toBe(0);
    expect(failing.calls.retry).toEqual([{ delaySeconds: retryDelaySeconds(1) }]);

    kit.apns.results.clear();
    const ok = batch({ kind: 'push.deliver', outboxId: row?.id }, 2);
    await handleQueue(ok.batch, kit.env, exec);
    expect(ok.calls.ack).toBe(1);
    expect((await getOutbox(kit.env.DB, row?.id ?? ''))?.state).toBe('sent');
  });

  it('acks messages it cannot parse', async () => {
    const bad = batch({ kind: 'nope' });
    await handleQueue(bad.batch, kit.env, exec);
    expect(bad.calls.ack).toBe(1);
  });

  it('finalizes exhausted jobs in the dead-letter queue', async () => {
    const pass = await kit.pass();
    await enqueuePush(job(), pass.id, 'refresh');
    await kit.settle();
    const row = await first<{ id: string }>(
      kit.env.DB,
      "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'push'",
      [pass.id],
    );
    const dlq = batch({ kind: 'push.deliver', outboxId: row?.id });
    (dlq.batch as { queue: string }).queue = 'wallet-jobs-dlq';
    await handleQueue(dlq.batch, kit.env, exec);
    expect(dlq.calls.ack).toBe(1);
    expect((await getOutbox(kit.env.DB, row?.id ?? ''))?.state).toBe('failed');
  });
});

describe('sweeper', () => {
  it('returns expired leases to the queue and fails those out of attempts', async () => {
    const stale = await kit.pass();
    const spent = await kit.pass();
    await enqueuePush(job(), stale.id, 'refresh');
    await enqueuePush(job(), spent.id, 'refresh');
    await kit.settle();
    const ids = async (passId: string) =>
      (
        await first<{ id: string }>(
          kit.env.DB,
          "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'push'",
          [passId],
        )
      )?.id ?? '';
    const [staleId, spentId] = [await ids(stale.id), await ids(spent.id)];
    const past = kit.clock.now() - 1000;
    await run(
      kit.env.DB,
      "UPDATE outbox SET state = 'processing', lease = 'x', attempts = 2, available_at = ? WHERE id = ?",
      [past, staleId],
    );
    await run(
      kit.env.DB,
      "UPDATE outbox SET state = 'processing', lease = 'x', attempts = max_attempts, available_at = ? WHERE id = ?",
      [past, spentId],
    );
    kit.queue.sent.length = 0;
    await sweepDelivery(job());
    expect(await getOutbox(kit.env.DB, spentId)).toMatchObject({
      state: 'failed',
      errorCode: 'LEASE_EXPIRED',
    });
    expect(await getOutbox(kit.env.DB, staleId)).toMatchObject({ state: 'enqueued', lease: null });
    expect(kit.queue.sent).toContainEqual({ kind: 'push.deliver', outboxId: staleId });
  });

  it('keeps a live lease alone', async () => {
    const pass = await kit.pass();
    await enqueuePush(job(), pass.id, 'refresh');
    await kit.settle();
    const row = await first<{ id: string }>(
      kit.env.DB,
      "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'push'",
      [pass.id],
    );
    await run(
      kit.env.DB,
      "UPDATE outbox SET state = 'processing', lease = 'x', available_at = ? WHERE id = ?",
      [kit.clock.now() + 60_000, row?.id],
    );
    await sweepDelivery(job());
    expect((await getOutbox(kit.env.DB, row?.id ?? ''))?.state).toBe('processing');
  });

  it('re-sends rows whose enqueue message was lost, but not fresh ones', async () => {
    const lost = await kit.pass();
    const fresh = await kit.pass();
    await enqueuePush(job(), lost.id, 'refresh');
    await enqueuePush(job(), fresh.id, 'refresh');
    await kit.settle();
    const idOf = async (passId: string) =>
      (
        await first<{ id: string }>(
          kit.env.DB,
          "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'push'",
          [passId],
        )
      )?.id ?? '';
    const lostId = await idOf(lost.id);
    await run(kit.env.DB, 'UPDATE outbox SET enqueued_at = ? WHERE id = ?', [
      kit.clock.now() - 20 * 60_000,
      lostId,
    ]);
    kit.queue.sent.length = 0;
    await sweepDelivery(job());
    expect(kit.queue.sent).toEqual([{ kind: 'push.deliver', outboxId: lostId }]);
    kit.queue.sent.length = 0;
    await sweepDelivery(job());
    expect(kit.queue.sent).toEqual([]);
  });
});

describe('retention', () => {
  it('deletes sent rows after 30 days and failed rows after 90, with their push results', async () => {
    const pass = await kit.pass();
    const now = kit.clock.now();
    const add = (id: string, state: string, age: number) =>
      run(
        kit.env.DB,
        `INSERT INTO outbox (id, org_id, kind, pass_id, state, created_at, finished_at) VALUES (?, ?, 'push', ?, ?, ?, ?)`,
        [id, kit.org.id, pass.id, state, now - age, now - age],
      );
    await add('old-sent', 'sent', 31 * DAY);
    await add('new-sent', 'sent', 29 * DAY);
    await add('old-failed', 'failed', 91 * DAY);
    await add('mid-failed', 'failed', 60 * DAY);
    await run(
      kit.env.DB,
      "INSERT INTO push_results (outbox_id, device_id, http_status, at) VALUES ('old-sent', 'd', 200, 1)",
    );
    await dailyDelivery(kit.ctx);
    const left = async (id: string) => getOutbox(kit.env.DB, id);
    expect(await left('old-sent')).toBeNull();
    expect(await left('old-failed')).toBeNull();
    expect(await left('new-sent')).not.toBeNull();
    expect(await left('mid-failed')).not.toBeNull();
    const orphan = await first(
      kit.env.DB,
      "SELECT 1 FROM push_results WHERE outbox_id = 'old-sent'",
    );
    expect(orphan).toBeNull();
  });
});

describe('claim guard', () => {
  it('never exceeds max_attempts when a message is redelivered', async () => {
    const pass = await kit.pass();
    await kit.device(pass, `dev-g-${pass.id}`, 'e'.repeat(64));
    await enqueuePush(job(), pass.id, 'refresh');
    await kit.settle();
    const row = await first<{ id: string }>(
      kit.env.DB,
      "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'push'",
      [pass.id],
    );
    kit.apns.results.set('e'.repeat(64), { status: 503 });
    await run(kit.env.DB, 'UPDATE outbox SET max_attempts = 3 WHERE id = ?', [row?.id]);
    for (let i = 0; i < 2; i++)
      await expect(
        handlePushDeliver({ kind: 'push.deliver', outboxId: row?.id ?? '' }, kit.ctx),
      ).rejects.toBeTruthy();
    await handlePushDeliver({ kind: 'push.deliver', outboxId: row?.id ?? '' }, kit.ctx);
    expect(await getOutbox(kit.env.DB, row?.id ?? '')).toMatchObject({
      attempts: 3,
      state: 'failed',
    });
    await handlePushDeliver({ kind: 'push.deliver', outboxId: row?.id ?? '' }, kit.ctx);
    expect((await getOutbox(kit.env.DB, row?.id ?? ''))?.attempts).toBe(3);
    kit.apns.results.clear();
  });
});
