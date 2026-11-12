import { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';
import { makeApiKey, makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { type AppBindings, requestContext } from '../../platform/context.ts';
import { all, first, run, type SqlValue } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { createAuthStores } from '../../stores.ts';
import { resolveSession } from '../auth/sessions.ts';
import { create as createConnection } from '../connections/service.ts';
import { approveAppleRelease, grantKitMembership } from '../passes/apple-release-test-fixtures.ts';
import {
  authOf,
  requireTenantSessionOrApiKey,
  type TenantPassWrite,
  tenantAuthorityOf,
} from '../passes/http.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { jobCtxOf } from './delivery-test-fixtures.ts';
import { EMAIL_RECIPIENT_HOURLY_CAP, enqueuePassEmail } from './issuance-intent.ts';
import { handleEmailSend } from './jobs.ts';
import { getOutbox } from './repo.ts';

const job = () => jobCtxOf(kit);

let kit: Kit;
beforeAll(async () => {
  kit = await setupKit();
});

const HOUR = 3_600_000;
const DAY = 86_400_000;
type EmailInput = Parameters<typeof enqueuePassEmail>[1];
type Counter = { key: string; window_start: number; count: number };

async function update(sql: string, params: SqlValue[]) {
  // meta.changes also counts trigger-owned epoch writes, so count the statement's own rows.
  expect(await all(kit.env.DB, `${sql} RETURNING 1`, params)).toHaveLength(1);
}

async function issued() {
  const release = kit.liveRelease;
  if (!release) throw new Error('Live release fixture missing');
  const to = `${kit.ctx.ids.id()}@example.com`;
  const pass = await kit.pass({ holderEmail: to });
  expect(await first(kit.env.DB, 'SELECT release_id FROM passes WHERE id = ?', [pass.id])).toEqual({
    release_id: release.id,
  });
  return { pass, release, to };
}

async function bound() {
  const f = await issued();
  const connection = await createConnection(job(), { type: 'system', id: null }, {
    orgId: kit.org.id,
    connectorType: 'demo',
    name: 'Email authority',
    config: { count: 1 },
    mode: 'manual',
  } as never);
  const externalRef = `member-${f.pass.id}`;
  await update('UPDATE connections SET generation = ? WHERE id = ?', [7, connection.id]);
  await update('UPDATE passes SET connection_id = ?, external_ref = ? WHERE id = ?', [
    connection.id,
    externalRef,
    f.pass.id,
  ]);
  const pass = await getPass(kit.env.DB, f.pass.id);
  if (!pass) throw new Error('Bound pass missing');
  return {
    ...f,
    pass,
    connection: { orgId: pass.orgId, connectionId: connection.id, externalRef, generation: 7 },
  };
}

async function apiAuthority() {
  const key = await makeApiKey(kit.fx, { orgId: kit.org.id });
  const captured: { authority?: TenantPassWrite } = {};
  const app = new Hono<AppBindings>();
  app.use('*', requestContext({ stores: createAuthStores, clock: kit.clock }));
  app.post('/', requireTenantSessionOrApiKey('passes:write'), async (c) => {
    captured.authority = await tenantAuthorityOf(kit.ctx, authOf(c), kit.org.id, 'passes:operate');
    return c.json({ ok: true });
  });
  const response = await app.request(
    'https://wallet.test/',
    {
      method: 'POST',
      headers: key.headers,
    },
    kit.env,
  );
  if (!captured.authority) throw new Error(`Unable to authorize API key: ${response.status}`);
  return { key, authority: captured.authority };
}

async function sessionAuthority() {
  const user = await makeUser(kit.fx);
  await grantKitMembership(kit, kit.org.id, user.id, ['pass_operator']);
  const session = await makeSession(kit.fx, { userId: user.id });
  const auth = await resolveSession(kit.env, kit.clock, session.cookieValue);
  if (!auth) throw new Error('Session fixture missing');
  return {
    authority: await tenantAuthorityOf(kit.ctx, auth, kit.org.id, 'passes:operate'),
    sessionId: auth.sessionId,
  };
}

async function systemInput() {
  const f = await issued();
  return { passId: f.pass.id, expected: f.pass, to: f.to, attach: true, release: f.release };
}

async function combinedInput() {
  const f = await bound();
  const { authority } = await apiAuthority();
  return {
    passId: f.pass.id,
    expected: f.pass,
    to: f.to,
    attach: true,
    release: f.release,
    connection: f.connection,
    authority,
  };
}

/** Intervene after the pass read, immediately before the real first D1 batch. */
function atInsert(passId: string, intervene?: () => Promise<void>) {
  let prefetched = false;
  let captured: { prefetched: boolean; sql: string[] } | null = null;
  let scheduled = 0;
  const statements = new WeakMap<
    D1PreparedStatement,
    { target: D1PreparedStatement; sql: string }
  >();
  const wrap = (target: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const proxy = new Proxy(target, {
      get(statement, prop) {
        if (prop === 'bind') return (...values: unknown[]) => wrap(statement.bind(...values), sql);
        if (prop === 'first')
          return async (...args: unknown[]) => {
            const method = Reflect.get(statement, prop, statement) as (
              ...values: unknown[]
            ) => Promise<unknown>;
            const result = await method.apply(statement, args);
            if (
              /\bFROM\s+passes\b/i.test(sql) &&
              result &&
              typeof result === 'object' &&
              'id' in result &&
              result.id === passId
            )
              prefetched = true;
            return result;
          };
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
          if (!captured) {
            captured = {
              prefetched,
              sql: batch.map((statement) => statements.get(statement)?.sql ?? ''),
            };
            if (intervene) await intervene();
          }
          return target.batch(
            batch.map((statement) => statements.get(statement)?.target ?? statement),
          );
        };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const env: AppEnv = { ...kit.env, DB: db };
  return {
    ctx: {
      ...job(),
      env,
      waitUntil: (promise: Promise<unknown>) => {
        scheduled++;
        kit.ctx.waitUntil(promise);
      },
    },
    capture: () => captured,
    scheduled: () => scheduled,
  };
}

type Seam = {
  ctx: Kit['ctx'];
  capture(): { prefetched: boolean; sql: string[] } | null;
  scheduled(): number;
};
function expectInsertSeam(seam: Seam) {
  const capture = seam.capture();
  expect(capture?.prefetched).toBe(true);
  expect(capture?.sql.join('\n')).toMatch(/\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+outbox\b/i);
}

async function effects(passId: string): Promise<Effects> {
  await kit.settle();
  return {
    counters: await all<Counter>(
      kit.env.DB,
      "SELECT * FROM counters WHERE key LIKE 'pass-email:%' ORDER BY key, window_start",
    ),
    outbox: await all(
      kit.env.DB,
      "SELECT * FROM outbox WHERE pass_id = ? AND kind = 'email' ORDER BY id",
      [passId],
    ),
    events: await all(
      kit.env.DB,
      "SELECT * FROM pass_events WHERE pass_id = ? AND kind LIKE 'email.%' ORDER BY id",
      [passId],
    ),
    audits: await all(kit.env.DB, 'SELECT * FROM audit_log WHERE target_id = ? ORDER BY id', [
      passId,
    ]),
    captured: await all(kit.env.DB, 'SELECT * FROM captured_emails WHERE pass_id = ? ORDER BY id', [
      passId,
    ]),
    queue: [...kit.queue.sent],
    sent: [...kit.mailer.sent],
  };
}

type Effects = {
  counters: Counter[];
  outbox: unknown[];
  events: unknown[];
  audits: unknown[];
  captured: unknown[];
  queue: unknown[];
  sent: unknown[];
};

const resendAudit = (passId: string, orgId: string) => ({
  orgId,
  actorType: 'user' as const,
  actorId: 'actor',
  action: 'pass.resend_email',
  targetType: 'pass',
  targetId: passId,
});
async function expectRejected(input: EmailInput, code: string, intervene?: () => Promise<void>) {
  const before = await effects(input.passId);
  const seam = atInsert(input.passId, intervene);
  await expect(enqueuePassEmail(seam.ctx, input)).rejects.toMatchObject({ code });
  expectInsertSeam(seam);
  expect(seam.scheduled()).toBe(0);
  expect(await effects(input.passId)).toEqual(before);
}
async function expectQueued(input: EmailInput, seam: Seam, before: Effects, outboxId: string) {
  expectInsertSeam(seam);
  const after = await effects(input.passId);
  expect(seam.scheduled()).toBe(1);
  expect(
    after.queue
      .slice(before.queue.length)
      .filter(
        (job) =>
          typeof job === 'object' && job !== null && 'kind' in job && job.kind === 'email.send',
      ),
  ).toEqual([{ kind: 'email.send', outboxId }]);
  expect(after).toMatchObject({
    sent: before.sent,
    captured: before.captured,
    audits: before.audits,
  });
  expect(after.outbox).toHaveLength(before.outbox.length + 1);
  expect(after.events).toHaveLength(before.events.length + 1);
  const pass = input.expected;
  const to = input.to.trim().toLowerCase();
  const row = await getOutbox(kit.env.DB, outboxId);
  expect(row).toMatchObject({
    id: outboxId,
    orgId: pass.orgId,
    passId: pass.id,
    kind: 'email',
    state: 'enqueued',
    payload: {
      to,
      attach: input.attach,
      intent: {
        format: 1,
        to,
        attach: input.attach,
        pass: {
          passId: pass.id,
          orgId: pass.orgId,
          mode: pass.mode,
          testDataQuarantined: false,
          holderEmail: pass.holderEmail,
          ownerUserId: pass.ownerUserId,
          version: pass.version,
          linkGeneration: pass.linkGeneration,
          objectKey: pass.objectKey,
          downloadTokenHash: await sha256Hex(pass.downloadToken),
          status: pass.status,
          removedAt: pass.removedAt,
        },
      },
    },
  });
  expect(JSON.stringify(row?.payload)).not.toContain(pass.downloadToken);
  const events = await all<{ org_id: string; pass_id: string; mode: string; data: string }>(
    kit.env.DB,
    "SELECT org_id, pass_id, mode, data FROM pass_events WHERE pass_id = ? AND kind = 'email.queued'",
    [pass.id],
  );
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ org_id: pass.orgId, pass_id: pass.id, mode: pass.mode });
  expect(JSON.parse(events[0]?.data ?? '{}')).toEqual({ outboxId, attached: input.attach });
  const now = kit.clock.now();
  const hash = (await sha256Hex(`pass-email:${to}`)).slice(0, 32);
  for (const [key, window] of [
    [`pass-email:${pass.mode}:org:${pass.orgId}`, now - (now % DAY)],
    [`pass-email:${pass.mode}:to:${hash}`, now - (now % HOUR)],
  ] as const) {
    const previous =
      before.counters.find((item) => item.key === key && item.window_start === window)?.count ?? 0;
    const current =
      after.counters.find((item) => item.key === key && item.window_start === window)?.count ?? 0;
    expect(current).toBe(previous + 1);
  }
}

describe('issued email authority at the outbox commit', () => {
  it('queues a trusted release-only system email', async () => {
    const input = await systemInput();
    const before = await effects(input.passId);
    const seam = atInsert(input.passId);
    const { outboxId } = await enqueuePassEmail(seam.ctx, { ...input, to: input.to.toUpperCase() });
    await expectQueued(input, seam, before, outboxId);
  });
  it.each(['api', 'session and additional API key'] as const)(
    'queues when %s and connection authorities remain valid',
    async (kind) => {
      const f = await bound();
      const api = await apiAuthority();
      const session = kind === 'api' ? null : await sessionAuthority();
      const input = {
        passId: f.pass.id,
        expected: f.pass,
        to: f.to,
        attach: true,
        release: f.release,
        connection: f.connection,
        authority: session?.authority ?? api.authority,
        ...(session ? { additionalAuthority: api.authority } : {}),
      };
      const before = await effects(input.passId);
      const seam = atInsert(input.passId);
      const { outboxId } = await enqueuePassEmail(seam.ctx, input);
      await expectQueued(input, seam, before, outboxId);
    },
  );
  it('commits a single audit alongside an issued connection email with both authorities', async () => {
    const f = await bound();
    const session = await sessionAuthority();
    const api = await apiAuthority();
    const input = {
      passId: f.pass.id,
      expected: f.pass,
      to: f.to,
      attach: true,
      release: f.release,
      connection: f.connection,
      authority: session.authority,
      additionalAuthority: api.authority,
      auditEntry: resendAudit(f.pass.id, f.pass.orgId),
    };
    const before = await effects(f.pass.id);
    const seam = atInsert(f.pass.id);
    const { outboxId } = await enqueuePassEmail(seam.ctx, input);
    expectInsertSeam(seam);
    const after = await effects(f.pass.id);
    expect(seam.scheduled()).toBe(1);
    expect(after.outbox).toHaveLength(before.outbox.length + 1);
    expect(after.events).toHaveLength(before.events.length + 1);
    expect(after.audits).toHaveLength(before.audits.length + 1);
    expect(after.queue.slice(before.queue.length)).toEqual([{ kind: 'email.send', outboxId }]);
    expect(after.sent).toEqual(before.sent);
  });
  it('rejects an API key revoked after prefetch despite a live connection and release', async () => {
    const f = await bound();
    const { key, authority } = await apiAuthority();
    await expectRejected(
      {
        passId: f.pass.id,
        expected: f.pass,
        to: f.to,
        attach: true,
        release: f.release,
        connection: f.connection,
        authority,
      },
      'FORBIDDEN',
      () => update('UPDATE api_keys SET revoked_at = ? WHERE id = ?', [kit.clock.now(), key.id]),
    );
  });
  it.each(['primary', 'additional'] as const)(
    'rejects a revoked %s authority without relying on the other authority',
    async (revoked) => {
      const f = await bound();
      const session = await sessionAuthority();
      const api = await apiAuthority();
      await expectRejected(
        {
          passId: f.pass.id,
          expected: f.pass,
          to: f.to,
          attach: true,
          release: f.release,
          connection: f.connection,
          authority: session.authority,
          additionalAuthority: api.authority,
          auditEntry: resendAudit(f.pass.id, f.pass.orgId),
        },
        'FORBIDDEN',
        () =>
          revoked === 'primary'
            ? update('UPDATE sessions SET revoked_at = ? WHERE id_hash = ?', [
                kit.clock.now(),
                session.sessionId,
              ])
            : update('UPDATE api_keys SET revoked_at = ? WHERE id = ?', [
                kit.clock.now(),
                api.key.id,
              ]),
      );
      const sessionRow = await first<{ revoked_at: number | null }>(
        kit.env.DB,
        'SELECT revoked_at FROM sessions WHERE id_hash = ?',
        [session.sessionId],
      );
      const keyRow = await first<{ revoked_at: number | null }>(
        kit.env.DB,
        'SELECT revoked_at FROM api_keys WHERE id = ?',
        [api.key.id],
      );
      expect(sessionRow?.revoked_at).toBe(revoked === 'primary' ? kit.clock.now() : null);
      expect(keyRow?.revoked_at).toBe(revoked === 'additional' ? kit.clock.now() : null);
    },
  );
  it('rejects a disabled connection even when the API key is still valid', async () => {
    const input = await combinedInput();
    await expectRejected(input, 'DELIVERY_STALE', () =>
      update('UPDATE connections SET enabled = 0 WHERE id = ?', [input.connection.connectionId]),
    );
  });
  it('classifies a pass deleted after prefetch as stale, not a revoked principal', async () => {
    const input = await combinedInput();
    await expectRejected(input, 'DELIVERY_STALE', () =>
      update('DELETE FROM passes WHERE id = ?', [input.passId]),
    );
  });

  it('does not consume capped counters for a valid combined authority', async () => {
    const input = await combinedInput();
    const hash = (await sha256Hex(`pass-email:${input.to}`)).slice(0, 32);
    const now = kit.clock.now();
    await run(
      kit.env.DB,
      `INSERT INTO counters (key, window_start, count) VALUES (?, ?, ?)
      ON CONFLICT (key, window_start) DO UPDATE SET count = excluded.count`,
      [`pass-email:live:to:${hash}`, now - (now % HOUR), EMAIL_RECIPIENT_HOURLY_CAP],
    );
    await expectRejected(input, 'EMAIL_RATE_LIMITED');
  });

  it('captures a release-supplied Test email in the inbox without calling the mailer', async () => {
    const release = kit.testRelease;
    if (!release) throw new Error('Test release fixture missing');
    const to = `${kit.ctx.ids.id()}@example.com`;
    const pass = await kit.pass({ holderEmail: to, mode: 'test' });
    expect(
      await first(kit.env.DB, 'SELECT release_id FROM passes WHERE id = ?', [pass.id]),
    ).toEqual({ release_id: release.id });
    const input = { passId: pass.id, expected: pass, to, attach: false, release };
    const before = await effects(pass.id);
    const seam = atInsert(pass.id);
    const { outboxId } = await enqueuePassEmail(seam.ctx, input);
    await expectQueued(input, seam, before, outboxId);
    await handleEmailSend({ kind: 'email.send', outboxId }, job());
    expect(kit.mailer.sent).toEqual(before.sent);
    expect(
      await first(kit.env.DB, 'SELECT state, error_code FROM outbox WHERE id = ?', [outboxId]),
    ).toEqual({ state: 'sent', error_code: 'TEST_MODE' });
    const capture = await first<{
      org_id: string;
      pass_id: string;
      recipient: string;
      attached: number;
      html: string;
    }>(
      kit.env.DB,
      'SELECT org_id, pass_id, recipient, attached, html FROM captured_emails WHERE outbox_id = ?',
      [outboxId],
    );
    expect(capture).toMatchObject({
      org_id: pass.orgId,
      pass_id: pass.id,
      recipient: to,
      attached: 0,
    });
    expect(capture?.html).toBeTruthy();
    const capturedEvents = await all<{ mode: string; data: string }>(
      kit.env.DB,
      "SELECT mode, data FROM pass_events WHERE pass_id = ? AND kind = 'email.captured'",
      [pass.id],
    );
    expect(capturedEvents).toHaveLength(1);
    expect(capturedEvents[0]?.mode).toBe('test');
    expect(JSON.parse(capturedEvents[0]?.data ?? '{}')).toEqual({ outboxId, attached: false });
  });
  it('honors the issued release after a new head and after a changed pass release pin', async () => {
    const survivor = await systemInput();
    const combinedSurvivor = await combinedInput();
    const staleSystem = await systemInput();
    const staleCombined = await combinedInput();
    const published: { release?: NonNullable<Kit['liveRelease']> } = {};
    const before = await effects(survivor.passId);
    const seam = atInsert(survivor.passId, async () => {
      published.release = await approveAppleRelease(kit);
    });
    const { outboxId } = await enqueuePassEmail(seam.ctx, survivor);
    await expectQueued(survivor, seam, before, outboxId);
    const later = published.release;
    if (!later) throw new Error('Later release not published');
    expect(later.id).not.toBe(survivor.release.id);
    expect(later.generation).toBeGreaterThan(survivor.release.generation);
    expect(later).toMatchObject({
      templateId: survivor.release.templateId,
      version: survivor.release.version,
      orgId: survivor.release.orgId,
      mode: survivor.release.mode,
      provider: survivor.release.provider,
    });
    expect(
      await first(kit.env.DB, 'SELECT release_id FROM passes WHERE id = ?', [survivor.passId]),
    ).toEqual({ release_id: survivor.release.id });
    const beforeCombined = await effects(combinedSurvivor.passId);
    const combinedSeam = atInsert(combinedSurvivor.passId);
    const queued = await enqueuePassEmail(combinedSeam.ctx, combinedSurvivor);
    await expectQueued(combinedSurvivor, combinedSeam, beforeCombined, queued.outboxId);
    // The pin is a release fact, checked at create and publish only: a re-pinned pass still mails.
    for (const input of [staleSystem, staleCombined]) {
      const seam = atInsert(input.passId, () =>
        update('UPDATE passes SET release_id = ? WHERE id = ?', [later.id, input.passId]),
      );
      await expect(enqueuePassEmail(seam.ctx, input)).resolves.toHaveProperty('outboxId');
    }
  });
});
