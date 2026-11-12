import { beforeAll, describe, expect, it } from 'vitest';
import { makeUser } from '../../../../test/helpers/index.ts';
import { all, first, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { reassignHolder, runAttachHookA } from '../holders/service.ts';
import { createPassRow } from '../passes/create.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import { publishPass } from '../passes/publish.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { beginAttemptFor, insertOutboxRaw, jobCtxOf } from './delivery-test-fixtures.ts';
import { dispatchOutbox, enqueuePassEmail, scheduleIssuanceDelivery } from './issuance-intent.ts';
import { handleEmailSend } from './jobs.ts';
import { getOutbox } from './repo.ts';
import { completeProviderAttempt } from './repo-binding.ts';
import { claimOutbox } from './repo-outbox-processing.ts';
import { enqueuePush } from './service.ts';

const job = () => jobCtxOf(kit);

let kit: Kit;
beforeAll(async () => {
  kit = await setupKit();
});
const actor = { type: 'system', id: null } as const;

/** Transfer after the producer's pass read, immediately before its actual outbox batch. */
function transferAtInsert(change: () => Promise<void>) {
  let fired = false;
  const statements = new WeakMap<
    D1PreparedStatement,
    { target: D1PreparedStatement; sql: string }
  >();
  const wrap = (target: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const proxy = new Proxy(target, {
      get(statement, prop) {
        if (prop === 'bind') return (...values: unknown[]) => wrap(statement.bind(...values), sql);
        const value = Reflect.get(statement, prop, statement);
        return typeof value === 'function' ? value.bind(statement) : value;
      },
    });
    statements.set(proxy, { target, sql });
    return proxy;
  };
  const db = new Proxy(kit.env.DB, {
    get(target, prop) {
      if (prop === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql);
      if (prop === 'batch')
        return async (batch: D1PreparedStatement[]) => {
          if (
            !fired &&
            batch.some((s) =>
              /INSERT\s+(?:OR\s+IGNORE\s+)?INTO\s+outbox/i.test(statements.get(s)?.sql ?? ''),
            )
          ) {
            fired = true;
            await change();
          }
          return target.batch(batch.map((s) => statements.get(s)?.target ?? s));
        };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const env: AppEnv = { ...kit.env, DB: db };
  return { ctx: { ...job(), env }, fired: () => fired };
}

async function issueWithEmail(to: string) {
  return createPassRow(job(), {
    orgId: kit.org.id,
    templateId: kit.template.id,
    templateVersion: kit.template.version,
    input: { memberName: 'Delivery holder' },
    holderEmail: to,
    sendEmail: true,
    source: 'manual',
    mode: 'live',
    actor,
    execution: { kind: 'system' },
  });
}

async function intent(passId: string) {
  const result = await first<{
    state: string;
    outbox_id: string | null;
    transfer_id: string | null;
  }>(
    kit.env.DB,
    'SELECT state,outbox_id,transfer_id FROM pass_issuance_deliveries WHERE pass_id = ?',
    [passId],
  );
  if (!result) throw new Error('Missing issuance delivery intent');
  return result;
}

describe('delivery transfer fences', () => {
  it.each(['email', 'push'] as const)(
    'rejects %s inserted after a completed transfer',
    async (kind) => {
      const pass = await kit.pass({ holderEmail: `${kit.ctx.ids.id()}@example.test` });
      const seam = transferAtInsert(async () => {
        await reassignHolder(
          jobCtxOf(kit),
          actor,
          { passId: pass.id, email: `${kit.ctx.ids.id()}@example.test` },
          null,
        );
        expect(
          await first(
            kit.env.DB,
            "SELECT state FROM pass_credential_transfers WHERE pass_id = ? AND state = 'completed'",
            [pass.id],
          ),
        ).toEqual({ state: 'completed' });
      });
      if (kind === 'email') {
        await expect(
          enqueuePassEmail(seam.ctx, {
            passId: pass.id,
            to: pass.holderEmail!,
            attach: false,
            expected: pass,
          }),
        ).rejects.toMatchObject({ code: 'DELIVERY_STALE' });
      } else {
        await expect(enqueuePush(seam.ctx, pass.id, 'refresh')).rejects.toMatchObject({
          code: 'PASS_NOT_FOUND',
        });
      }
      expect(seam.fired()).toBe(true);
      if (kind === 'email') {
        expect(
          await all(kit.env.DB, "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'email'", [
            pass.id,
          ]),
        ).toEqual([]);
      } else {
        expect(
          await all(
            kit.env.DB,
            `SELECT id FROM outbox WHERE pass_id = ? AND kind = 'push'
        AND json_extract(payload, '$.credentialGeneration') = ?`,
            [pass.id, pass.credentialGeneration],
          ),
        ).toEqual([]);
      }
      // Only the transfer's own publish queued anything; the rejected attempt left no event.
      expect(
        await all(
          kit.env.DB,
          "SELECT kind, data FROM pass_events WHERE pass_id = ? AND kind IN ('email.queued','push.queued')",
          [pass.id],
        ),
      ).toEqual([{ kind: 'push.queued', data: JSON.stringify({ version: 2, devices: 0 }) }]);
    },
  );

  it('publishes an incarnation-scoped push even beside a legacy pending push', async () => {
    const pass = await kit.pass();
    await insertOutboxRaw(kit.env.DB, {
      id: `legacy-push:${pass.id}`,
      orgId: pass.orgId,
      kind: 'push',
      passId: pass.id,
      coalesceKey: `push:${pass.id}`,
      payload: {},
      now: kit.clock.now(),
    });
    const published = await publishPass(jobCtxOf(kit), {
      passId: pass.id,
      cause: 'admin',
      actor,
      dispatch: false,
      mutate: () => ({ personalization: { memberName: 'Updated delivery holder' } }),
    });
    expect(published.changed).toBe(true);
    const row = await first<{ coalesce_key: string; payload: string }>(
      kit.env.DB,
      "SELECT coalesce_key,payload FROM outbox WHERE id = ? AND kind = 'push'",
      [`push:${pass.id}:${published.pass.version}`],
    );
    expect(row?.coalesce_key).toBe(
      `push:${JSON.stringify([
        pass.id,
        pass.identityId,
        pass.credentialGeneration,
        pass.lifecycleGeneration,
        published.pass.templateId,
        published.pass.templateVersion,
        published.pass.releaseId,
      ])}`,
    );
    expect(JSON.parse(row?.payload ?? '{}')).toEqual({
      reason: 'publish',
      identityId: pass.identityId,
      credentialGeneration: pass.credentialGeneration,
      lifecycleGeneration: pass.lifecycleGeneration,
      templateId: published.pass.templateId,
      templateVersion: published.pass.templateVersion,
      releaseId: published.pass.releaseId,
    });
  });

  it('recovers an issuance intent after a post-commit failure before enqueue', async () => {
    const passId = kit.ctx.ids.id();
    const email = `${kit.ctx.ids.id()}@example.test`;
    await run(
      kit.env.DB,
      `CREATE TRIGGER fail_issuance_enqueue BEFORE INSERT ON outbox
      WHEN NEW.kind = 'email' BEGIN SELECT RAISE(ABORT, 'outbox unavailable'); END`,
    );
    try {
      // The pass and its pending intent commit together; the enqueue after the commit is deferred.
      await createPassRow(job(), {
        passId,
        orgId: kit.org.id,
        templateId: kit.template.id,
        templateVersion: kit.template.version,
        input: { memberName: 'Recoverable issuance' },
        holderEmail: email,
        sendEmail: true,
        source: 'manual',
        mode: 'live',
        actor,
        execution: { kind: 'system' },
      });
    } finally {
      await run(kit.env.DB, 'DROP TRIGGER fail_issuance_enqueue');
    }
    expect(await intent(passId)).toMatchObject({ state: 'pending', outbox_id: null });
    const pass = await getPass(kit.env.DB, passId);
    if (!pass) throw new Error('Committed pass missing');
    expect(await kit.env.BUCKET.get(pass.objectKey)).not.toBeNull();
    await dispatchOutbox(job(), { passId });
    const recovered = await intent(passId);
    if (!recovered.outbox_id) throw new Error('Recovery did not enqueue the requested email');
    const sent = kit.mailer.sent.length;
    await handleEmailSend({ kind: 'email.send', outboxId: recovered.outbox_id }, job());
    await dispatchOutbox(job(), { passId });
    await handleEmailSend({ kind: 'email.send', outboxId: recovered.outbox_id }, job());
    expect(kit.mailer.sent).toHaveLength(sent + 1);
    expect(kit.mailer.sent.at(-1)?.html).toContain(pass.downloadToken);
    expect(
      await all(kit.env.DB, "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'email'", [passId]),
    ).toHaveLength(1);
    await run(kit.env.DB, 'DELETE FROM outbox WHERE id = ?', [recovered.outbox_id]);
    expect(await scheduleIssuanceDelivery(job(), passId)).toBe('queued');
    expect(
      await all(kit.env.DB, "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'email'", [passId]),
    ).toEqual([]);
  });

  it('preserves an unknown provider outcome after outbox retention without resending', async () => {
    const pass = await issueWithEmail(`${kit.ctx.ids.id()}@example.test`);
    const queued = await intent(pass.id);
    if (!queued.outbox_id) throw new Error('Missing issuance email');
    kit.mailer.fail = new Error('connection lost');
    try {
      await handleEmailSend({ kind: 'email.send', outboxId: queued.outbox_id }, job());
    } finally {
      kit.mailer.fail = null;
    }
    expect(await getOutbox(kit.env.DB, queued.outbox_id)).toMatchObject({
      state: 'partial',
      errorCode: 'EMAIL_OUTCOME_UNKNOWN',
    });
    await expect(scheduleIssuanceDelivery(job(), pass.id)).rejects.toMatchObject({
      code: 'EMAIL_OUTCOME_UNKNOWN',
    });
    await run(kit.env.DB, 'DELETE FROM outbox WHERE id = ?', [queued.outbox_id]);
    await expect(scheduleIssuanceDelivery(job(), pass.id)).rejects.toMatchObject({
      code: 'EMAIL_OUTCOME_UNKNOWN',
    });
    expect(
      await all(kit.env.DB, "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'email'", [
        pass.id,
      ]),
    ).toEqual([]);
  });

  it('does not allow replacing or reopening an existing issuance intent', async () => {
    const source = await issueWithEmail(`${kit.ctx.ids.id()}@example.test`);
    const before = await intent(source.id);
    expect(before.state).toBe('queued');
    await expect(
      run(
        kit.env.DB,
        `INSERT OR REPLACE INTO pass_issuance_deliveries
      SELECT * FROM pass_issuance_deliveries WHERE pass_id = ?`,
        [source.id],
      ),
    ).rejects.toThrow();
    await expect(
      run(
        kit.env.DB,
        `UPDATE pass_issuance_deliveries
      SET state = 'pending', outbox_id = NULL WHERE pass_id = ?`,
        [source.id],
      ),
    ).rejects.toThrow();
    expect(await intent(source.id)).toEqual(before);
  });

  it('moves a queued, unattempted issuance email through the exact verified attach without duplicate sends', async () => {
    const email = `${kit.ctx.ids.id()}@example.test`;
    const source = await issueWithEmail(email);
    await kit.settle();
    const initial = await intent(source.id);
    if (!initial.outbox_id) throw new Error('Missing first outbox row');
    await makeUser(kit.fx, { primaryEmail: email });
    expect(await runAttachHookA(kit.ctx, source.id)).toMatchObject({ state: 'completed' });
    expect(await scheduleIssuanceDelivery(job(), source.id)).toBe('queued');
    const next = await intent(source.id);
    const current = await getPass(kit.env.DB, source.id);
    if (!next.outbox_id || !current) throw new Error('Missing transferred delivery');
    expect(next.outbox_id).not.toBe(initial.outbox_id);
    expect(next.transfer_id).not.toBeNull();
    expect(await getOutbox(kit.env.DB, initial.outbox_id)).toMatchObject({
      state: 'cancelled',
      errorCode: 'TRANSFER_SUPERSEDED',
    });
    const before = kit.mailer.sent.length;
    await handleEmailSend({ kind: 'email.send', outboxId: initial.outbox_id }, job());
    await handleEmailSend({ kind: 'email.send', outboxId: next.outbox_id }, job());
    await handleEmailSend({ kind: 'email.send', outboxId: next.outbox_id }, job());
    expect(kit.mailer.sent).toHaveLength(before + 1);
    expect(kit.mailer.sent.at(-1)).toMatchObject({ to: email });
    expect(kit.mailer.sent.at(-1)?.html).toContain(current.downloadToken);
    expect(kit.mailer.sent.at(-1)?.html).not.toContain(source.downloadToken);
  });

  it('does not rotate during an irreversible provider attempt or re-send an accepted issuance', async () => {
    const email = `${kit.ctx.ids.id()}@example.test`;
    const source = await issueWithEmail(email);
    const initial = await intent(source.id);
    if (!initial.outbox_id) throw new Error('Missing first outbox row');
    const lease = kit.ctx.ids.token(8);
    expect(
      await claimOutbox(kit.env.DB, initial.outbox_id, lease, kit.clock.now(), 60_000),
    ).not.toBeNull();
    expect(await beginAttemptFor(job(), initial.outbox_id, lease, kit.clock.now())).toBe(true);
    await makeUser(kit.fx, { primaryEmail: email });
    expect(await runAttachHookA(kit.ctx, source.id)).toBeNull();
    expect(
      await all(kit.env.DB, 'SELECT id FROM pass_credential_transfers WHERE pass_id = ?', [
        source.id,
      ]),
    ).toEqual([]);
    expect(
      await completeProviderAttempt(
        kit.env.DB,
        initial.outbox_id,
        lease,
        'accepted',
        kit.clock.now(),
      ),
    ).toBe(true);
    expect(await runAttachHookA(kit.ctx, source.id)).toMatchObject({ state: 'completed' });
    expect(await scheduleIssuanceDelivery(job(), source.id)).toBe('queued');
    expect(await intent(source.id)).toMatchObject({
      state: 'queued',
      outbox_id: initial.outbox_id,
    });
    expect(
      await all(kit.env.DB, "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'email'", [
        source.id,
      ]),
    ).toHaveLength(1);
  });
});
