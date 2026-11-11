import { beforeAll, describe, expect, it, vi } from 'vitest';
import { makeUser } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { clearBlock, reassignHolder } from '../holders/service.ts';
import { removePassFromUser } from '../holders/service-remove.ts';
import { ownerSessionId } from '../holders/test-auth-fixtures.ts';
import { createPassRow } from '../passes/create.ts';
import { rotateLink } from '../passes/pass-service-delivery.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import { publishPass } from '../passes/publish.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { beginAttemptFor, insertOutboxRaw, jobCtxOf } from './delivery-test-fixtures.ts';
import { failEmail } from './email-outcome.ts';
import { enqueuePassEmail } from './issuance-intent.ts';
import { handleEmailSend, sweepDelivery } from './jobs.ts';
import { getOutbox } from './repo.ts';
import { claimOutbox } from './repo-outbox-processing.ts';

const job = () => jobCtxOf(kit);

let kit: Kit;
beforeAll(async () => {
  kit = await setupKit();
});
const actor = { type: 'system', id: null } as const;

async function moveAndPersonalize(passId: string, email: string) {
  await reassignHolder(jobCtxOf(kit), actor, { passId, email }, null);
  return (
    await publishPass(jobCtxOf(kit), {
      passId,
      cause: 'admin',
      actor,
      mutate: () => ({ personalization: { memberName: 'Replacement Holder' } }),
    })
  ).pass;
}

describe('durable pass email intent', () => {
  it('cancels a queued A email after reassignment and sends only B the replacement link and artifact', async () => {
    const original = await kit.pass({ holderEmail: 'old-delivery@example.com' });
    const old = await enqueuePassEmail(job(), {
      passId: original.id,
      to: 'old-delivery@example.com',
      attach: true,
      expected: original,
    });
    const replacement = await moveAndPersonalize(original.id, 'new-delivery@example.com');
    expect(replacement.downloadToken).not.toBe(original.downloadToken);
    expect(replacement.objectKey).not.toBe(original.objectKey);
    const next = await enqueuePassEmail(job(), {
      passId: replacement.id,
      to: 'new-delivery@example.com',
      attach: true,
      expected: replacement,
    });
    const before = kit.mailer.sent.length;
    await handleEmailSend({ kind: 'email.send', outboxId: old.outboxId }, job());
    expect(await getOutbox(kit.env.DB, old.outboxId)).toMatchObject({
      state: 'cancelled',
      errorCode: 'DELIVERY_STALE',
    });
    expect(kit.mailer.sent).toHaveLength(before);
    await handleEmailSend({ kind: 'email.send', outboxId: next.outboxId }, job());
    const sent = kit.mailer.sent.at(-1);
    expect(kit.mailer.sent).toHaveLength(before + 1);
    expect(sent?.to).toBe('new-delivery@example.com');
    expect(sent?.html).toContain(replacement.downloadToken);
    expect(sent?.html).not.toContain(original.downloadToken);
    const artifact = await kit.env.BUCKET.get(replacement.objectKey);
    expect(artifact).not.toBeNull();
    expect(sent?.attachments?.[0]?.content).toEqual(new Uint8Array(await artifact!.arrayBuffer()));
  });

  it('does not upgrade a retry after a pre-provider preparation failure', async () => {
    const original = await kit.pass({ holderEmail: 'retry-old@example.com' });
    const queued = await enqueuePassEmail(job(), {
      passId: original.id,
      to: 'retry-old@example.com',
      attach: true,
      expected: original,
    });
    const lease = kit.ctx.ids.token(8);
    const row = await claimOutbox(kit.env.DB, queued.outboxId, lease, kit.clock.now(), 60_000);
    if (!row) throw new Error('outbox claim failed');
    await expect(
      failEmail(
        jobCtxOf(kit),
        { row, lease },
        {
          orgId: original.orgId,
          passId: original.id,
          mode: original.mode,
          templateId: original.templateId,
          identityId: original.identityId,
          attached: true,
        },
        new Error('artifact storage unavailable'),
      ),
    ).rejects.toMatchObject({ code: 'EMAIL_FAILED' });
    await moveAndPersonalize(original.id, 'retry-new@example.com');
    const before = kit.mailer.sent.length;
    await handleEmailSend({ kind: 'email.send', outboxId: queued.outboxId }, job());
    expect(kit.mailer.sent).toHaveLength(before);
    // The transfer cancels the released row itself, so the redelivery claims nothing more.
    expect(await getOutbox(kit.env.DB, queued.outboxId)).toMatchObject({
      state: 'cancelled',
      attempts: 1,
      errorCode: 'DELIVERY_STALE',
    });
  });

  it('rejects a stale producer snapshot and cancels a queued pre-rotation link', async () => {
    const pass = await kit.pass({ holderEmail: 'rotate-delivery@example.com' });
    const queued = await enqueuePassEmail(job(), {
      passId: pass.id,
      to: 'rotate-delivery@example.com',
      attach: false,
      expected: pass,
    });
    await rotateLink(jobCtxOf(kit), actor, pass.id, null);
    await expect(
      enqueuePassEmail(job(), {
        passId: pass.id,
        to: 'rotate-delivery@example.com',
        attach: false,
        expected: pass,
      }),
    ).rejects.toMatchObject({ code: 'DELIVERY_STALE' });
    const before = kit.mailer.sent.length;
    await handleEmailSend({ kind: 'email.send', outboxId: queued.outboxId }, job());
    expect(kit.mailer.sent).toHaveLength(before);
    expect(await getOutbox(kit.env.DB, queued.outboxId)).toMatchObject({
      state: 'cancelled',
      errorCode: 'DELIVERY_STALE',
    });
    const current = await getPass(kit.env.DB, pass.id);
    expect(current).not.toBeNull();
    const reviewed = await enqueuePassEmail(job(), {
      passId: pass.id,
      to: 'rotate-delivery@example.com',
      attach: false,
      expected: current!,
    });
    await handleEmailSend({ kind: 'email.send', outboxId: reviewed.outboxId }, job());
    expect(kit.mailer.sent.at(-1)?.html).toContain(current!.downloadToken);
  });

  it('does not revive an intent when the same owner is detached and reattached', async () => {
    const email = 'owner-aba@example.com';
    const user = await makeUser(kit.fx, { primaryEmail: email });
    const pass = await kit.pass({ holderEmail: email });
    expect(pass.ownerUserId).toBe(user.id);
    const queued = await enqueuePassEmail(job(), {
      passId: pass.id,
      to: email,
      attach: false,
      expected: pass,
    });
    await removePassFromUser(jobCtxOf(kit), pass.id, user.id, await ownerSessionId(kit, user.id));
    await clearBlock(jobCtxOf(kit), actor, { passId: pass.id, userId: user.id }, null);
    const restored = await getPass(kit.env.DB, pass.id);
    expect(restored?.ownerUserId).toBe(user.id);
    expect(restored?.downloadToken).not.toBe(pass.downloadToken);
    expect(restored?.linkGeneration).toBeGreaterThan(pass.linkGeneration);
    const before = kit.mailer.sent.length;
    await handleEmailSend({ kind: 'email.send', outboxId: queued.outboxId }, job());
    expect(kit.mailer.sent).toHaveLength(before);
    expect(await getOutbox(kit.env.DB, queued.outboxId)).toMatchObject({
      state: 'cancelled',
      errorCode: 'DELIVERY_STALE',
    });
  });

  it('rechecks after preparing mail, before the provider call', async () => {
    const pass = await kit.pass({ holderEmail: 'during-old@example.com' });
    const queued = await enqueuePassEmail(job(), {
      passId: pass.id,
      to: 'during-old@example.com',
      attach: true,
      expected: pass,
    });
    const resolve = kit.registry.resolve.bind(kit.registry);
    const spy = vi.spyOn(kit.registry, 'resolve').mockImplementationOnce(async (...args) => {
      await moveAndPersonalize(pass.id, 'during-new@example.com');
      return resolve(...args);
    });
    const before = kit.mailer.sent.length;
    try {
      await handleEmailSend({ kind: 'email.send', outboxId: queued.outboxId }, job());
    } finally {
      spy.mockRestore();
    }
    expect(kit.mailer.sent).toHaveLength(before);
    expect(await getOutbox(kit.env.DB, queued.outboxId)).toMatchObject({
      state: 'cancelled',
      errorCode: 'DELIVERY_STALE',
    });
  });

  it('records an accepted-but-disconnected provider call as unknown without resending', async () => {
    const pass = await kit.pass();
    const queued = await enqueuePassEmail(job(), {
      passId: pass.id,
      to: 'ambiguous@example.com',
      attach: false,
      expected: pass,
    });
    const send = kit.mailer.send.bind(kit.mailer);
    const spy = vi.spyOn(kit.mailer, 'send').mockImplementationOnce(async (message) => {
      await send(message);
      throw new Error('connection lost after acceptance');
    });
    const before = kit.mailer.sent.length;
    try {
      await handleEmailSend({ kind: 'email.send', outboxId: queued.outboxId }, job());
    } finally {
      spy.mockRestore();
    }
    expect(kit.mailer.sent).toHaveLength(before + 1);
    expect(await getOutbox(kit.env.DB, queued.outboxId)).toMatchObject({
      state: 'partial',
      errorCode: 'EMAIL_OUTCOME_UNKNOWN',
    });
    await handleEmailSend({ kind: 'email.send', outboxId: queued.outboxId }, job());
    expect(kit.mailer.sent).toHaveLength(before + 1);
  });

  it('settles an expired provider marker as unknown rather than retrying after a crash', async () => {
    const pass = await kit.pass();
    const queued = await enqueuePassEmail(job(), {
      passId: pass.id,
      to: 'crash@example.com',
      attach: false,
      expected: pass,
    });
    const lease = kit.ctx.ids.token(8);
    expect(
      await claimOutbox(kit.env.DB, queued.outboxId, lease, kit.clock.now(), 1000),
    ).not.toBeNull();
    expect(await beginAttemptFor(job(), queued.outboxId, lease, kit.clock.now())).toBe(true);
    kit.clock.advance(1001);
    await sweepDelivery(job());
    expect(await getOutbox(kit.env.DB, queued.outboxId)).toMatchObject({
      state: 'partial',
      errorCode: 'EMAIL_OUTCOME_UNKNOWN',
    });
    const before = kit.mailer.sent.length;
    await handleEmailSend({ kind: 'email.send', outboxId: queued.outboxId }, job());
    expect(kit.mailer.sent).toHaveLength(before);
  });

  it('records a known late provider acceptance after the lease was settled unknown', async () => {
    const pass = await kit.pass();
    const queued = await enqueuePassEmail(job(), {
      passId: pass.id,
      to: 'late-provider@example.com',
      attach: false,
      expected: pass,
    });
    const send = kit.mailer.send.bind(kit.mailer);
    const spy = vi.spyOn(kit.mailer, 'send').mockImplementationOnce(async (message) => {
      kit.clock.advance(6 * 60_000);
      await sweepDelivery(job());
      expect(await getOutbox(kit.env.DB, queued.outboxId)).toMatchObject({
        state: 'partial',
        errorCode: 'EMAIL_OUTCOME_UNKNOWN',
      });
      return send(message);
    });
    const before = kit.mailer.sent.length;
    try {
      await handleEmailSend({ kind: 'email.send', outboxId: queued.outboxId }, job());
    } finally {
      spy.mockRestore();
    }
    expect(await getOutbox(kit.env.DB, queued.outboxId)).toMatchObject({
      state: 'sent',
      errorCode: null,
    });
    await handleEmailSend({ kind: 'email.send', outboxId: queued.outboxId }, job());
    expect(kit.mailer.sent).toHaveLength(before + 1);
  });

  it('will not cross the provider boundary with a stale pass snapshot', async () => {
    const pass = await kit.pass({ holderEmail: 'fence-old@example.com' });
    const queued = await enqueuePassEmail(job(), {
      passId: pass.id,
      to: 'fence-old@example.com',
      attach: false,
      expected: pass,
    });
    const lease = kit.ctx.ids.token(8);
    expect(
      await claimOutbox(kit.env.DB, queued.outboxId, lease, kit.clock.now(), 60_000),
    ).not.toBeNull();
    await reassignHolder(
      jobCtxOf(kit),
      actor,
      { passId: pass.id, email: 'fence-new@example.com' },
      null,
    );
    expect(await beginAttemptFor(job(), queued.outboxId, lease, kit.clock.now())).toBe(false);
  });

  it('persists provider acceptance before a failing pass-event write', async () => {
    const pass = await kit.pass();
    const queued = await enqueuePassEmail(job(), {
      passId: pass.id,
      to: 'event-failure@example.com',
      attach: false,
      expected: pass,
    });
    await run(
      kit.env.DB,
      `CREATE TRIGGER fail_delivery_event BEFORE INSERT ON pass_events
      WHEN NEW.kind = 'email.sent' BEGIN SELECT RAISE(ABORT, 'event unavailable'); END`,
    );
    const before = kit.mailer.sent.length;
    try {
      // Event writes are best effort (EVENT_RECORD_FAILED is logged), so the job still settles.
      await expect(
        handleEmailSend({ kind: 'email.send', outboxId: queued.outboxId }, job()),
      ).resolves.toBeUndefined();
    } finally {
      await run(kit.env.DB, 'DROP TRIGGER fail_delivery_event');
    }
    expect(await getOutbox(kit.env.DB, queued.outboxId)).toMatchObject({ state: 'sent' });
    await handleEmailSend({ kind: 'email.send', outboxId: queued.outboxId }, job());
    expect(kit.mailer.sent).toHaveLength(before + 1);
  });

  it('fails closed for unbound legacy rows but settles a known provider acceptance', async () => {
    const pass = await kit.pass();
    const id = kit.ctx.ids.id();
    await insertOutboxRaw(kit.env.DB, {
      id,
      orgId: pass.orgId,
      kind: 'email',
      passId: pass.id,
      coalesceKey: null,
      payload: { to: 'legacy@example.com', attach: false },
      now: kit.clock.now(),
    });
    await handleEmailSend({ kind: 'email.send', outboxId: id }, job());
    expect(await getOutbox(kit.env.DB, id)).toMatchObject({
      state: 'cancelled',
      errorCode: 'DELIVERY_UNBOUND',
    });
    const accepted = kit.ctx.ids.id();
    await insertOutboxRaw(kit.env.DB, {
      id: accepted,
      orgId: pass.orgId,
      kind: 'email',
      passId: pass.id,
      coalesceKey: null,
      payload: { to: 'legacy@example.com', attach: false },
      now: kit.clock.now(),
    });
    await run(kit.env.DB, 'UPDATE outbox SET provider_id = ? WHERE id = ?', [
      'provider-accepted',
      accepted,
    ]);
    await handleEmailSend({ kind: 'email.send', outboxId: accepted }, job());
    expect(await getOutbox(kit.env.DB, accepted)).toMatchObject({
      state: 'sent',
      providerId: 'provider-accepted',
    });
  });

  it('never captures a test-mode message after a holder change', async () => {
    const pass = await createPassRow(jobCtxOf(kit), {
      orgId: kit.org.id,
      templateId: kit.template.id,
      templateVersion: kit.template.version,
      input: { memberName: 'Test holder' },
      holderEmail: 'test-old@example.com',
      source: 'manual',
      mode: 'test',
      actor,
      execution: { kind: 'system' },
    });
    const queued = await enqueuePassEmail(job(), {
      passId: pass.id,
      to: 'test-old@example.com',
      attach: false,
      expected: pass,
    });
    await reassignHolder(
      jobCtxOf(kit),
      actor,
      { passId: pass.id, email: 'test-new@example.com' },
      null,
    );
    await handleEmailSend({ kind: 'email.send', outboxId: queued.outboxId }, job());
    expect(
      await first(kit.env.DB, 'SELECT id FROM captured_emails WHERE outbox_id = ?', [
        queued.outboxId,
      ]),
    ).toBeNull();
    expect(await getOutbox(kit.env.DB, queued.outboxId)).toMatchObject({
      state: 'cancelled',
      errorCode: 'DELIVERY_STALE',
    });
  });
});
