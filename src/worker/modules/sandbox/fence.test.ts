import type { OpenAPIHono } from '@hono/zod-openapi';
import { beforeAll, describe, expect, it } from 'vitest';
import { stagePendingCredentialTransfer } from '../../../../test/helpers/credential-transfer.ts';
import { makeOrg, makeUser, type SessionFixture } from '../../../../test/helpers/index.ts';
import { CapturedEmailListSchema } from '../../../shared/contracts/index.ts';
import type { AppBindings } from '../../platform/context.ts';
import { first, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { enqueueBundleEmail } from '../bundles/email-queue.ts';
import { createBundle } from '../bundles/service.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { enqueuePassEmail } from '../delivery/issuance-intent.ts';
import { handleEmailSend } from '../delivery/jobs.ts';
import { getOutbox } from '../delivery/repo.ts';
import type { OutboxRow } from '../delivery/repo-outbox-map.ts';
import { claimOutbox } from '../delivery/repo-outbox-processing.ts';
import { getHolderPass } from '../holders/repo.ts';
import { startCredentialTransfer } from '../passes/credential-transfer.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import type { Pass } from '../passes/repo.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { resolveCaptureSnapshot } from './binding.ts';
import { captureEmail } from './capture.ts';
import { getCapturedReference, readCaptured } from './repo-capture.ts';
import { sendCapturedToMe } from './service.ts';
import {
  grantInboxMembership,
  inboxApp,
  inboxAuthority,
  inboxHeaders,
  inboxMember,
  scopedInboxPath,
} from './test-tenant-fixtures.ts';

const ORIGIN = 'https://wallet.test';
const actor = { type: 'user', id: 'sandbox-fence-admin' } as const;
let kit: Kit;
let session: SessionFixture;
let app: OpenAPIHono<AppBindings>;

beforeAll(async () => {
  kit = await setupKit();
  await makeUser(kit.fx, { id: actor.id, primaryEmail: 'sandbox-fence-admin@example.com' });
  session = (await inboxMember(kit, actor.id)).session;
  app = inboxApp(kit);
});

const uniqueEmail = () => `${kit.ctx.ids.token(8).toLowerCase()}@example.com`;
const tokenOf = (url: string) => url.split('/b/')[1] ?? '';
const api = (path: string, init: RequestInit = {}, orgId = kit.org.id) =>
  app.request(
    `${ORIGIN}/api/v1${scopedInboxPath(path, orgId)}`,
    { ...init, headers: inboxHeaders(session) },
    kit.env,
  );

function testPass(email = uniqueEmail(), orgId = kit.org.id): Promise<Pass> {
  return kit.pass({ orgId, mode: 'test', memberName: 'Sandbox fence', holderEmail: email });
}

async function pendingTransfer(passId: string) {
  await stagePendingCredentialTransfer(kit.env.DB, passId, {
    id: kit.fx.ids.id(),
    token: kit.ctx.ids.token(),
    now: kit.clock.now(),
    targetHolderEmail: uniqueEmail(),
  });
}

async function queuedPass() {
  const to = uniqueEmail();
  const pass = await testPass(to);
  const { outboxId } = await enqueuePassEmail(jobCtxOf(kit), {
    passId: pass.id,
    to,
    attach: true,
    expected: pass,
  });
  return { pass, to, outboxId };
}

async function queuedBundle() {
  const to = uniqueEmail();
  const passes = [await testPass(to), await testPass(to)];
  const bundle = await createBundle(
    jobCtxOf(kit),
    { type: 'system', id: null },
    'test',
    {
      orgId: kit.org.id,
      passIds: passes.map((p) => p.id),
      name: 'Sandbox bundle',
      holderEmail: to,
    },
    { kind: 'system' },
  );
  const { outboxId } = await enqueueBundleEmail(jobCtxOf(kit), bundle.id, to, {
    token: tokenOf(bundle.url),
    holderEmail: to,
  });
  return { passes, bundle, to, outboxId };
}

async function claim(id: string): Promise<{ row: OutboxRow; lease: string }> {
  await kit.settle();
  const lease = kit.ctx.ids.token(8);
  const row = await claimOutbox(kit.env.DB, id, lease, kit.clock.now(), 86_400_000);
  if (!row) throw new Error('outbox claim failed');
  return { row, lease };
}

/** Pause immediately before the capture transaction, after all preflight reads have succeeded. */
function raceBatch(mutate: () => Promise<void>): ServiceContext {
  let invoked = false;
  const db = new Proxy(kit.env.DB, {
    get(target, prop) {
      if (prop === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          if (!invoked) {
            invoked = true;
            await mutate();
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const env: AppEnv = { ...kit.env, DB: db };
  return { ...jobCtxOf(kit), env };
}

/** Change a pass while send-to-me is awaiting the verified-address lookup. */
function raceVerifiedLookup(mutate: () => Promise<void>): ServiceContext {
  let invoked = false;
  const db = new Proxy(kit.env.DB, {
    get(target, prop) {
      if (prop === 'prepare')
        return (sql: string) => {
          const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
            new Proxy(statement, {
              get(inner, key) {
                if (key === 'bind') return (...args: unknown[]) => wrap(inner.bind(...args));
                if (key === 'first' && sql.includes('FROM users u JOIN user_emails e')) {
                  return async (column?: string) => {
                    if (!invoked) {
                      invoked = true;
                      await mutate();
                    }
                    return column === undefined ? inner.first() : inner.first(column);
                  };
                }
                const value = Reflect.get(inner, key, inner);
                return typeof value === 'function' ? value.bind(inner) : value;
              },
            });
          return wrap(target.prepare(sql));
        };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const env: AppEnv = { ...kit.env, DB: db };
  return { ...jobCtxOf(kit), env };
}

const message = {
  subject: 'Sensitive subject',
  html: '<p>Secret test body</p>',
  text: 'Secret test body',
};

async function assertNoCapture(id: string, passId: string) {
  expect(
    await first(kit.env.DB, 'SELECT id FROM captured_emails WHERE outbox_id = ?', [id]),
  ).toBeNull();
  expect(
    await first(
      kit.env.DB,
      "SELECT id FROM pass_events WHERE pass_id = ? AND kind IN ('email.captured', 'email.sent', 'email.failed') AND json_extract(data, '$.outboxId') = ?",
      [passId, id],
    ),
  ).toBeNull();
}

async function capturePassWithRace(mutate: (pass: Pass, outboxId: string) => Promise<void>) {
  const queued = await queuedPass();
  const claimed = await claim(queued.outboxId);
  const inserted = await captureEmail(
    raceBatch(() => mutate(queued.pass, queued.outboxId)),
    {
      ...claimed,
      orgId: queued.pass.orgId,
      eventPassId: queued.pass.id,
      passId: queued.pass.id,
      to: queued.to,
      attached: true,
      email: message,
    },
  );
  return { ...queued, ...claimed, inserted };
}

async function captureBundleWithRace(
  mutate: (passes: Pass[], bundleId: string, outboxId: string) => Promise<void>,
) {
  const queued = await queuedBundle();
  const claimed = await claim(queued.outboxId);
  const firstPass = queued.passes[0]!;
  const inserted = await captureEmail(
    raceBatch(() => mutate(queued.passes, queued.bundle.id, queued.outboxId)),
    {
      ...claimed,
      orgId: kit.org.id,
      eventPassId: firstPass.id,
      bundleId: queued.bundle.id,
      to: queued.to,
      email: message,
    },
  );
  return { ...queued, ...claimed, inserted };
}

async function captured(id: string) {
  const row = await first<{ id: string }>(
    kit.env.DB,
    'SELECT id FROM captured_emails WHERE outbox_id = ?',
    [id],
  );
  if (!row) throw new Error('capture missing');
  return row.id;
}

async function deliver(id: string) {
  await handleEmailSend({ kind: 'email.send', outboxId: id }, jobCtxOf(kit));
  return captured(id);
}

describe('atomic test email capture', () => {
  it('does not capture when quarantine wins after the preflight read', async () => {
    const result = await capturePassWithRace(async (pass) => {
      await run(kit.env.DB, 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', [pass.id]);
    });
    expect(result.inserted).toBe(false);
    expect(await getOutbox(kit.env.DB, result.outboxId)).toMatchObject({
      state: 'cancelled',
      errorCode: 'DELIVERY_STALE',
      providerId: null,
    });
    await assertNoCapture(result.outboxId, result.pass.id);
  });

  it('does not capture if the organization is suspended after preflight', async () => {
    try {
      const result = await capturePassWithRace(async () => {
        await run(kit.env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [kit.org.id]);
      });
      expect(result.inserted).toBe(false);
      expect(await getOutbox(kit.env.DB, result.outboxId)).toMatchObject({
        state: 'cancelled',
        errorCode: 'ORG_INACTIVE',
      });
      await assertNoCapture(result.outboxId, result.pass.id);
    } finally {
      await run(kit.env.DB, "UPDATE orgs SET status = 'active' WHERE id = ?", [kit.org.id]);
    }
  });

  it('does not capture with an expired or replaced lease', async () => {
    for (const mode of ['expired', 'replaced'] as const) {
      const result = await capturePassWithRace(async (_pass, id) => {
        if (mode === 'expired')
          await run(kit.env.DB, 'UPDATE outbox SET available_at = ? WHERE id = ?', [
            kit.clock.now(),
            id,
          ]);
        else
          await run(kit.env.DB, 'UPDATE outbox SET lease = ? WHERE id = ?', ['another-worker', id]);
      });
      expect(result.inserted).toBe(false);
      expect(await getOutbox(kit.env.DB, result.outboxId)).toMatchObject({
        state: 'processing',
        providerId: null,
        ...(mode === 'replaced' ? { lease: 'another-worker' } : { lease: result.lease }),
      });
      await assertNoCapture(result.outboxId, result.pass.id);
    }
  }, 60_000);

  it('does not capture after a pending or completed transfer, token rotation or lifecycle change', async () => {
    for (const field of ['pending', 'completed', 'token', 'lifecycle'] as const) {
      const result = await capturePassWithRace(async (pass) => {
        if (field === 'pending') {
          await pendingTransfer(pass.id);
        } else if (field === 'completed') {
          const expected = await getHolderPass(kit.env.DB, pass.id, null);
          if (!expected) throw new Error('Missing holder snapshot');
          expect(
            await startCredentialTransfer(
              jobCtxOf(kit),
              { type: 'system', id: null },
              pass.id,
              { holderEmail: uniqueEmail(), ownerUserId: null },
              null,
              { kind: 'tenant-holder', expected },
            ),
          ).toMatchObject({ state: 'completed' });
        } else if (field === 'token') {
          await run(
            kit.env.DB,
            'UPDATE passes SET download_token = ?, link_generation = link_generation + 1 WHERE id = ?',
            [kit.ctx.ids.token(), pass.id],
          );
        } else {
          await run(
            kit.env.DB,
            'UPDATE passes SET lifecycle_generation = lifecycle_generation + 1 WHERE id = ?',
            [pass.id],
          );
        }
      });
      expect(result.inserted).toBe(false);
      expect(await getOutbox(kit.env.DB, result.outboxId)).toMatchObject({
        state: 'cancelled',
        errorCode: 'DELIVERY_STALE',
      });
      await assertNoCapture(result.outboxId, result.pass.id);
      if (field === 'pending' || field === 'completed') {
        const current = await getPass(kit.env.DB, result.pass.id);
        if (!current?.holderEmail) throw new Error('Missing current pass');
        const enqueue = enqueuePassEmail(jobCtxOf(kit), {
          passId: current.id,
          to: current.holderEmail,
          attach: false,
          expected: current,
        });
        if (field === 'pending') {
          await expect(enqueue).rejects.toMatchObject({ code: 'DELIVERY_STALE' });
        } else {
          const next = await enqueue;
          expect(await deliver(next.outboxId)).toBeTruthy();
          expect(await getOutbox(kit.env.DB, next.outboxId)).toMatchObject({
            state: 'sent',
            errorCode: 'TEST_MODE',
          });
        }
      }
    }
  }, 120_000);

  it('checks the outbox payload again in the insert, not just the claimed copy', async () => {
    const result = await capturePassWithRace(async (_pass, id) => {
      await run(
        kit.env.DB,
        "UPDATE outbox SET payload = json_set(payload, '$.to', 'changed@example.com') WHERE id = ?",
        [id],
      );
    });
    expect(result.inserted).toBe(false);
    expect(await getOutbox(kit.env.DB, result.outboxId)).toMatchObject({ state: 'cancelled' });
    await assertNoCapture(result.outboxId, result.pass.id);
  });

  it('rejects changed bundle members and a rotated bundle token', async () => {
    for (const change of [
      'removed',
      'reordered',
      'quarantined',
      'token',
      'pending',
      'completed',
      'lifecycle',
    ] as const) {
      const result = await captureBundleWithRace(async (passes, bundleId) => {
        if (change === 'removed')
          await run(kit.env.DB, 'DELETE FROM bundle_passes WHERE bundle_id = ? AND pass_id = ?', [
            bundleId,
            passes[1]!.id,
          ]);
        else if (change === 'reordered')
          await run(
            kit.env.DB,
            'UPDATE bundle_passes SET position = 1 - position WHERE bundle_id = ?',
            [bundleId],
          );
        else if (change === 'quarantined')
          await run(kit.env.DB, 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', [
            passes[1]!.id,
          ]);
        else if (change === 'token')
          await run(kit.env.DB, 'UPDATE bundles SET token = ? WHERE id = ?', [
            kit.ctx.ids.token(),
            bundleId,
          ]);
        else if (change === 'pending') await pendingTransfer(passes[1]!.id);
        else if (change === 'completed') {
          const expected = await getHolderPass(kit.env.DB, passes[1]!.id, null);
          if (!expected) throw new Error('Missing holder snapshot');
          expect(
            await startCredentialTransfer(
              jobCtxOf(kit),
              { type: 'system', id: null },
              passes[1]!.id,
              { holderEmail: uniqueEmail(), ownerUserId: null },
              null,
              { kind: 'tenant-holder', expected },
            ),
          ).toMatchObject({ state: 'completed' });
        } else
          await run(
            kit.env.DB,
            'UPDATE passes SET lifecycle_generation = lifecycle_generation + 1 WHERE id = ?',
            [passes[1]!.id],
          );
      });
      expect(result.inserted).toBe(false);
      expect(await getOutbox(kit.env.DB, result.outboxId)).toMatchObject({
        state: 'cancelled',
        errorCode: 'DELIVERY_STALE',
      });
      await assertNoCapture(result.outboxId, result.passes[0]!.id);
    }
  }, 120_000);

  it('captures unchanged test pass and bundle intents without invoking the provider', async () => {
    const pass = await queuedPass();
    const bundle = await queuedBundle();
    const before = kit.mailer.sent.length;
    for (const id of [pass.outboxId, bundle.outboxId]) {
      const captureId = await deliver(id);
      const row = await first<{ intent: string }>(
        kit.env.DB,
        'SELECT intent FROM captured_emails WHERE id = ?',
        [captureId],
      );
      expect(JSON.parse(row!.intent)).toMatchObject({
        format: 1,
        to: id === pass.outboxId ? pass.to : bundle.to,
      });
      expect(await getOutbox(kit.env.DB, id)).toMatchObject({
        state: 'sent',
        errorCode: 'TEST_MODE',
      });
      const response = await api(`/test-inbox/${captureId}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    expect((await api('/test-inbox')).headers.get('cache-control')).toBe('no-store');
    expect(kit.mailer.sent).toHaveLength(before);
  }, 60_000);
});

describe('existing capture exposure', () => {
  it('keeps quarantined and transferred pass captures readable but refuses to forward them', async () => {
    for (const change of ['quarantine', 'pending', 'transfer'] as const) {
      const queued = await queuedPass();
      const id = await deliver(queued.outboxId);
      if (change === 'quarantine') {
        await run(kit.env.DB, 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', [
          queued.pass.id,
        ]);
      } else if (change === 'pending') {
        await pendingTransfer(queued.pass.id);
      } else {
        const expected = await getHolderPass(kit.env.DB, queued.pass.id, null);
        if (!expected) throw new Error('Missing holder snapshot');
        expect(
          await startCredentialTransfer(
            jobCtxOf(kit),
            { type: 'system', id: null },
            queued.pass.id,
            { holderEmail: uniqueEmail(), ownerUserId: null },
            null,
            { kind: 'tenant-holder', expected },
          ),
        ).toMatchObject({ state: 'completed' });
      }
      const before = kit.mailer.sent.length;
      expect((await api(`/test-inbox/${id}`)).status).toBe(200);
      expect((await api(`/test-inbox/${id}/html`)).status).toBe(200);
      const sent = await api(`/test-inbox/${id}/send-to-me`, { method: 'POST' });
      expect(sent.status).toBe(409);
      expect(await sent.json()).toMatchObject({ code: 'TEST_FORWARD_CHANGED' });
      const list = CapturedEmailListSchema.parse(await (await api('/test-inbox?limit=200')).json());
      expect(list.items.some((item) => item.id === id)).toBe(true);
      expect(kit.mailer.sent).toHaveLength(before);
      expect(
        await first(kit.env.DB, 'SELECT id FROM captured_emails WHERE id = ?', [id]),
      ).not.toBeNull();
    }
  }, 120_000);

  it('keeps bundle captures readable after a member or the token changes, but refuses to forward them', async () => {
    for (const change of ['removed', 'quarantined', 'token', 'pending', 'transfer'] as const) {
      const queued = await queuedBundle();
      const id = await deliver(queued.outboxId);
      if (change === 'removed')
        await run(kit.env.DB, 'DELETE FROM bundle_passes WHERE bundle_id = ? AND pass_id = ?', [
          queued.bundle.id,
          queued.passes[1]!.id,
        ]);
      else if (change === 'quarantined')
        await run(kit.env.DB, 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', [
          queued.passes[1]!.id,
        ]);
      else if (change === 'token')
        await run(kit.env.DB, 'UPDATE bundles SET token = ? WHERE id = ?', [
          kit.ctx.ids.token(),
          queued.bundle.id,
        ]);
      else if (change === 'pending') await pendingTransfer(queued.passes[1]!.id);
      else {
        const expected = await getHolderPass(kit.env.DB, queued.passes[1]!.id, null);
        if (!expected) throw new Error('Missing holder snapshot');
        expect(
          await startCredentialTransfer(
            jobCtxOf(kit),
            { type: 'system', id: null },
            queued.passes[1]!.id,
            { holderEmail: uniqueEmail(), ownerUserId: null },
            null,
            { kind: 'tenant-holder', expected },
          ),
        ).toMatchObject({ state: 'completed' });
      }
      expect((await api(`/test-inbox/${id}`)).status).toBe(200);
      expect((await api(`/test-inbox/${id}/html`)).status).toBe(200);
      expect((await api(`/test-inbox/${id}/send-to-me`, { method: 'POST' })).status).toBe(409);
      const list = CapturedEmailListSchema.parse(await (await api('/test-inbox?limit=200')).json());
      expect(list.items.some((item) => item.id === id)).toBe(true);
    }
  }, 120_000);

  it('uses the final read predicate when quarantine wins after intent validation', async () => {
    const queued = await queuedPass();
    const id = await deliver(queued.outboxId);
    const authority = await inboxAuthority(kit, session, 'passes:read');
    const ref = await getCapturedReference(kit.env.DB, id, authority, kit.clock.now());
    if (!ref) throw new Error('reference missing');
    const snapshot = await resolveCaptureSnapshot(kit.env.DB, ref);
    if (!snapshot) throw new Error('snapshot missing');
    await run(kit.env.DB, 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', [
      queued.pass.id,
    ]);
    expect(
      await readCaptured(kit.env.DB, ref, snapshot, true, authority, kit.clock.now()),
    ).toBeNull();
    expect(
      await readCaptured(kit.env.DB, ref, snapshot, false, authority, kit.clock.now()),
    ).toBeNull();
  });

  it('revalidates send-to-me after the verified-address lookup', async () => {
    const queued = await queuedPass();
    const id = await deliver(queued.outboxId);
    const before = kit.mailer.sent.length;
    const ctx = raceVerifiedLookup(async () => {
      await run(kit.env.DB, 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', [
        queued.pass.id,
      ]);
    });
    await expect(
      sendCapturedToMe(ctx, await inboxAuthority(kit, session), id),
    ).rejects.toMatchObject({ code: 'TEST_FORWARD_CHANGED' });
    expect(kit.mailer.sent).toHaveLength(before);
  });

  it('lists changed captures and pages by cursor', async () => {
    kit.clock.advance(10);
    const older = await queuedPass();
    const olderId = await deliver(older.outboxId);
    kit.clock.advance(10);
    const visible = await queuedPass();
    const visibleId = await deliver(visible.outboxId);
    kit.clock.advance(10);
    const hidden = await queuedPass();
    const hiddenId = await deliver(hidden.outboxId);
    await run(kit.env.DB, 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', [
      hidden.pass.id,
    ]);
    const firstPage = CapturedEmailListSchema.parse(
      await (await api('/test-inbox?limit=1')).json(),
    );
    expect(firstPage.items.map((item) => item.id)).toEqual([hiddenId]);
    expect(firstPage.nextCursor).toBe(hiddenId);
    const second = CapturedEmailListSchema.parse(
      await (await api(`/test-inbox?limit=1&cursor=${encodeURIComponent(visibleId)}`)).json(),
    );
    expect(second.items.map((item) => item.id)).toEqual([olderId]);
  }, 60_000);

  it('shows an unbound legacy capture but never forwards it, and keeps a bound capture after outbox retention', async () => {
    const legacy = await queuedPass();
    const legacyId = await deliver(legacy.outboxId);
    await run(kit.env.DB, 'UPDATE captured_emails SET intent = NULL WHERE id = ?', [legacyId]);
    expect((await api(`/test-inbox/${legacyId}`)).status).toBe(200);
    expect((await api(`/test-inbox/${legacyId}/send-to-me`, { method: 'POST' })).status).toBe(409);
    const current = await queuedPass();
    const currentId = await deliver(current.outboxId);
    await run(kit.env.DB, 'DELETE FROM outbox WHERE id = ?', [current.outboxId]);
    expect((await api(`/test-inbox/${currentId}`)).status).toBe(200);
  }, 60_000);

  it('hides captures when their organization becomes inactive', async () => {
    const org = await makeOrg(kit.fx, { name: 'Suspended sandbox org' });
    await grantInboxMembership(kit, actor.id, org.id);
    const to = uniqueEmail();
    const pass = await testPass(to, org.id);
    const queued = await enqueuePassEmail(jobCtxOf(kit), {
      passId: pass.id,
      to,
      attach: false,
      expected: pass,
    });
    const id = await deliver(queued.outboxId);
    await run(kit.env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [org.id]);
    expect((await api(`/test-inbox/${id}`, {}, org.id)).status).toBe(404);
    expect((await api(`/test-inbox/${id}/send-to-me`, { method: 'POST' }, org.id)).status).toBe(
      404,
    );
  });
});
