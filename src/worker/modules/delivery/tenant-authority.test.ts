import { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';
import { makeApiKey, makeOrg, makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { type AppBindings, requestContext } from '../../platform/context.ts';
import { first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { createAuthStores } from '../../stores.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createSessionStore, resolveSession } from '../auth/sessions.ts';
import { grantKitMembership } from '../passes/apple-release-test-fixtures.ts';
import { createPassRow } from '../passes/create.ts';
import {
  authOf,
  requireTenantSessionOrApiKey,
  type TenantPassWrite,
  tenantAuthorityOf,
} from '../passes/http.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import { jobCtxOf } from './delivery-test-fixtures.ts';
import { enqueuePassEmail, scheduleIssuanceDelivery } from './issuance-intent.ts';
import { handleEmailSend } from './jobs.ts';
import { getOutbox } from './repo.ts';
import { listPassDeliveries, queueEmail } from './service.ts';

const job = () => jobCtxOf(kit);

let kit: Kit;
beforeAll(async () => {
  kit = await setupKit();
});

async function effects(passId: string) {
  await kit.settle();
  return first<{ counters: number; outbox: number; events: number; audits: number }>(
    kit.env.DB,
    `SELECT (SELECT COALESCE(SUM(count), 0) FROM counters WHERE key LIKE 'pass-email:%') AS counters,
      (SELECT COUNT(*) FROM outbox WHERE pass_id = ? AND kind = 'email') AS outbox,
      (SELECT COUNT(*) FROM pass_events WHERE pass_id = ? AND kind = 'email.queued') AS events,
      (SELECT COUNT(*) FROM audit_log WHERE target_id = ?) AS audits`,
    [passId, passId, passId],
  );
}

/** Intervene after the service preflight, immediately before its first D1 transaction. */
async function atEnqueueCommit<T>(
  mutate: () => Promise<void>,
  call: (ctx: Kit['ctx']) => Promise<T>,
): Promise<T> {
  let intercepted = false;
  const db = new Proxy(kit.env.DB, {
    get(target, property) {
      if (property === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          if (!intercepted) {
            intercepted = true;
            await mutate();
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  try {
    return await call({ ...job(), env: { ...kit.env, DB: db } });
  } finally {
    expect(intercepted).toBe(true);
  }
}

async function sessionAuthority() {
  const user = await makeUser(kit.fx);
  const membership = await grantKitMembership(kit, kit.org.id, user.id, ['pass_operator']);
  const session = await makeSession(kit.fx, { userId: user.id });
  const auth = await resolveSession(kit.env, kit.clock, session.cookieValue);
  if (!auth) throw new Error('Session fixture missing');
  return {
    authority: await tenantAuthorityOf(kit.ctx, auth, kit.org.id, 'passes:operate'),
    membership,
    sessionId: auth.sessionId,
    session,
  };
}

async function apiAuthority(scope: 'passes:read' | 'passes:write' = 'passes:write') {
  const key = await makeApiKey(kit.fx, { orgId: kit.org.id, scopes: [scope] });
  const captured: { authority?: TenantPassWrite } = {};
  const app = new Hono<AppBindings>();
  app.use('*', requestContext({ stores: createAuthStores, clock: kit.clock }));
  app.post('/', requireTenantSessionOrApiKey(scope), async (c) => {
    captured.authority = await tenantAuthorityOf(
      kit.ctx,
      authOf(c),
      kit.org.id,
      scope === 'passes:read' ? 'passes:read' : 'passes:operate',
    );
    return c.json({ ok: true });
  });
  const response = await app.request(
    'https://wallet.test/',
    { method: 'POST', headers: key.headers },
    kit.env,
  );
  if (!captured.authority) throw new Error(`API key fixture failed: ${response.status}`);
  return { authority: captured.authority, key };
}

describe('tenant email enqueue authority', () => {
  for (const revoked of ['session', 'membership'] as const) {
    it(`leaves no side effects after ${revoked} revocation`, async () => {
      const pass = await kit.pass();
      const { authority, membership, sessionId } = await sessionAuthority();
      const before = await effects(pass.id);
      await expect(
        atEnqueueCommit(
          async () => {
            if (revoked === 'session')
              await run(kit.env.DB, 'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?', [
                kit.clock.now(),
                sessionId,
              ]);
            else
              await run(kit.env.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
                kit.clock.now(),
                membership,
              ]);
          },
          (ctx) =>
            enqueuePassEmail(ctx, {
              passId: pass.id,
              expected: pass,
              to: `${pass.id}@example.test`,
              attach: false,
              authority,
            }),
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(await effects(pass.id)).toEqual(before);
    });
  }

  it('leaves no side effects after API key revocation', async () => {
    const pass = await kit.pass();
    const { authority, key } = await apiAuthority();
    const before = await effects(pass.id);
    await expect(
      atEnqueueCommit(
        async () => {
          await run(kit.env.DB, 'UPDATE api_keys SET revoked_at = ? WHERE id = ?', [
            kit.clock.now(),
            key.id,
          ]);
        },
        (ctx) =>
          enqueuePassEmail(ctx, {
            passId: pass.id,
            expected: pass,
            to: `${pass.id}@example.test`,
            attach: false,
            authority,
          }),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await effects(pass.id)).toEqual(before);
  });

  it('does not enqueue a different mode from the captured authority', async () => {
    const pass = await kit.pass({ mode: 'test' });
    const { authority } = await sessionAuthority();
    const before = await effects(pass.id);
    await expect(
      enqueuePassEmail(job(), {
        passId: pass.id,
        expected: pass,
        to: `${pass.id}@example.test`,
        attach: false,
        authority,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await effects(pass.id)).toEqual(before);
  });

  it('does not treat read-only authority as permission to queue pass or bundle mail', async () => {
    const pass = await kit.pass();
    const user = await makeUser(kit.fx);
    await grantKitMembership(kit, kit.org.id, user.id, ['read_only']);
    const session = await makeSession(kit.fx, { userId: user.id });
    const auth = await resolveSession(kit.env, kit.clock, session.cookieValue);
    if (!auth) throw new Error('Session fixture missing');
    const authority = await tenantAuthorityOf(kit.ctx, auth, kit.org.id, 'passes:read');
    const before = await effects(pass.id);
    await expect(
      enqueuePassEmail(job(), {
        passId: pass.id,
        expected: pass,
        to: `${pass.id}@example.test`,
        attach: false,
        authority,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      queueEmail(job(), {
        orgId: pass.orgId,
        passId: pass.id,
        mode: pass.mode,
        to: `${pass.id}@example.test`,
        payload: {},
        event: {},
        authority,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const readerKey = await apiAuthority('passes:read');
    await expect(
      enqueuePassEmail(job(), {
        passId: pass.id,
        expected: pass,
        to: `${pass.id}@example.test`,
        attach: false,
        authority: readerKey.authority,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await effects(pass.id)).toEqual(before);
  });

  it('rejects a bundle payload without its captured commit snapshot', async () => {
    const pass = await kit.pass();
    const { authority } = await sessionAuthority();
    const before = await effects(pass.id);
    await expect(
      queueEmail(job(), {
        orgId: pass.orgId,
        passId: pass.id,
        mode: pass.mode,
        to: `${pass.id}@example.test`,
        payload: { bundleId: 'missing-snapshot' },
        event: {},
        authority,
      }),
    ).rejects.toMatchObject({ code: 'DELIVERY_STALE' });
    expect(await effects(pass.id)).toEqual(before);
  });

  it('queues and records an authorized request', async () => {
    const pass = await kit.pass();
    const { authority } = await sessionAuthority();
    const before = await effects(pass.id);
    await enqueuePassEmail(job(), {
      passId: pass.id,
      expected: pass,
      to: `${pass.id}@example.test`,
      attach: false,
      authority,
    });
    const after = await effects(pass.id);
    expect(after).toEqual({
      counters: (before?.counters ?? 0) + 2,
      outbox: 1,
      events: 1,
      audits: before?.audits ?? 0,
    });
  });

  it('rechecks membership before recording an event after the outbox commit', async () => {
    const pass = await kit.pass();
    const { authority, membership } = await sessionAuthority();
    let revoked = false;
    const db = new Proxy(kit.env.DB, {
      get(target, property) {
        if (property === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            const result = await target.batch(statements);
            if (!revoked) {
              revoked = true;
              await run(kit.env.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
                kit.clock.now(),
                membership,
              ]);
            }
            return result;
          };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await expect(
      enqueuePassEmail(
        { ...job(), env: { ...kit.env, DB: db } },
        {
          passId: pass.id,
          expected: pass,
          to: `${pass.id}@example.test`,
          attach: false,
          authority,
        },
      ),
    ).resolves.toHaveProperty('outboxId');
    expect(revoked).toBe(true);
    expect(await effects(pass.id)).toMatchObject({ outbox: 1, events: 0 });
  });

  it('keeps the queued email when the best-effort event ledger fails', async () => {
    const pass = await kit.pass();
    const { authority } = await sessionAuthority();
    await run(
      kit.env.DB,
      `CREATE TRIGGER reject_queued_email BEFORE INSERT ON pass_events
      WHEN NEW.kind = 'email.queued' BEGIN SELECT RAISE(ABORT, 'ledger unavailable'); END`,
    );
    try {
      await expect(
        enqueuePassEmail(job(), {
          passId: pass.id,
          expected: pass,
          to: `${pass.id}@example.test`,
          attach: false,
          authority,
        }),
      ).resolves.toHaveProperty('outboxId');
      expect(await effects(pass.id)).toMatchObject({ outbox: 1, events: 0 });
    } finally {
      await run(kit.env.DB, 'DROP TRIGGER reject_queued_email');
    }
  });

  it('batches general queue audit with the authorized outbox and counters', async () => {
    const pass = await kit.pass();
    const { authority, membership } = await sessionAuthority();
    const input = {
      orgId: pass.orgId,
      passId: pass.id,
      mode: pass.mode,
      to: `${pass.id}@example.test`,
      payload: {},
      event: {},
      authority,
      auditEntry: {
        orgId: pass.orgId,
        actorType: 'user' as const,
        actorId: 'actor',
        action: 'bundle.send_email',
        targetType: 'bundle',
        targetId: pass.id,
      },
    };
    const before = await effects(pass.id);
    await expect(
      atEnqueueCommit(
        async () => {
          await run(kit.env.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
            kit.clock.now(),
            membership,
          ]);
        },
        (ctx) => queueEmail(ctx, input),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await effects(pass.id)).toEqual(before);
    const replacement = await sessionAuthority();
    await queueEmail(job(), { ...input, authority: replacement.authority });
    expect(await effects(pass.id)).toEqual({
      counters: (before?.counters ?? 0) + 2,
      outbox: (before?.outbox ?? 0) + 1,
      events: (before?.events ?? 0) + 1,
      audits: (before?.audits ?? 0) + 1,
    });
    await queueEmail(job(), { ...input, authority: replacement.authority });
    await queueEmail(job(), { ...input, authority: replacement.authority });
    const capped = await effects(pass.id);
    await expect(
      queueEmail(job(), { ...input, authority: replacement.authority }),
    ).rejects.toMatchObject({ code: 'EMAIL_RATE_LIMITED' });
    expect(await effects(pass.id)).toEqual(capped);
  });

  it('rolls back an issued email and both counters when its audit insert fails', async () => {
    const pass = await kit.pass();
    const { authority } = await sessionAuthority();
    const before = await effects(pass.id);
    const auditEntry = {
      orgId: pass.orgId,
      actorType: 'user' as const,
      actorId: 'actor',
      action: 'pass.resend_email',
      targetType: 'pass',
      targetId: pass.id,
    };
    await run(
      kit.env.DB,
      `CREATE TRIGGER reject_resend_audit BEFORE INSERT ON audit_log
      WHEN NEW.action = 'pass.resend_email' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`,
    );
    try {
      await expect(
        enqueuePassEmail(job(), {
          passId: pass.id,
          expected: pass,
          to: `${pass.id}@example.test`,
          attach: false,
          authority,
          auditEntry,
        }),
      ).rejects.toThrow();
      expect(await effects(pass.id)).toEqual(before);
    } finally {
      await run(kit.env.DB, 'DROP TRIGGER reject_resend_audit');
    }
    await enqueuePassEmail(job(), {
      passId: pass.id,
      expected: pass,
      to: `${pass.id}@example.test`,
      attach: false,
      authority,
      auditEntry,
    });
    expect(await effects(pass.id)).toEqual({
      counters: (before?.counters ?? 0) + 2,
      outbox: (before?.outbox ?? 0) + 1,
      events: (before?.events ?? 0) + 1,
      audits: (before?.audits ?? 0) + 1,
    });
  });

  it('rechecks the original issuer at the irreversible provider boundary', async () => {
    const { authority, key } = await apiAuthority();
    const email = `${kit.ctx.ids.id()}@example.test`;
    const release = kit.liveRelease;
    if (!release) throw new Error('Missing live release');
    const pass = await createPassRow(kit.ctx, {
      orgId: kit.org.id,
      templateId: kit.template.id,
      templateVersion: release.version,
      releaseId: release.id,
      releaseGeneration: release.generation,
      input: { memberName: 'Authorized issuance' },
      holderEmail: email,
      sendEmail: true,
      source: 'manual',
      mode: 'live',
      actor: { type: 'api_key', id: key.id },
      execution: { kind: 'tenant', authority },
    });
    const delivery = await first<{ outbox_id: string }>(
      kit.env.DB,
      'SELECT outbox_id FROM pass_issuance_deliveries WHERE pass_id = ?',
      [pass.id],
    );
    if (!delivery?.outbox_id) throw new Error('Missing issuance email');
    await run(kit.env.DB, 'UPDATE api_keys SET revoked_at = ? WHERE id = ?', [
      kit.clock.now(),
      key.id,
    ]);
    const sent = kit.mailer.sent.length;
    await handleEmailSend({ kind: 'email.send', outboxId: delivery.outbox_id }, job());
    expect(kit.mailer.sent).toHaveLength(sent);
    expect(await getOutbox(kit.env.DB, delivery.outbox_id)).toMatchObject({
      state: 'cancelled',
      errorCode: 'ACTOR_REVOKED',
    });
    expect(await scheduleIssuanceDelivery(job(), pass.id)).toBe('cancelled');
  });
});

describe('delivery listing tenant access', () => {
  it('requires an explicit organization, checks membership and masks foreign passes', async () => {
    const pass = await kit.pass();
    const { outboxId } = await enqueuePassEmail(job(), {
      passId: pass.id,
      expected: pass,
      to: `${pass.id}@example.test`,
      attach: false,
    });
    await kit.settle();
    const reader = await makeUser(kit.fx);
    await grantKitMembership(kit, kit.org.id, reader.id, ['read_only']);
    const session = await makeSession(kit.fx, { userId: reader.id });
    const outsider = await makeUser(kit.fx);
    const admin = await makeSession(kit.fx, { userId: outsider.id, roles: ['admin'] });
    const otherOrg = await makeOrg(kit.fx);
    const foreignOutbox = kit.ctx.ids.id();
    await run(
      kit.env.DB,
      `INSERT INTO outbox (id, org_id, kind, pass_id, payload, created_at)
      VALUES (?, ?, 'email', ?, '{}', ?)`,
      [foreignOutbox, otherOrg.id, pass.id, kit.clock.now()],
    );
    await grantKitMembership(kit, otherOrg.id, outsider.id, ['pass_operator']);
    const readKey = await makeApiKey(kit.fx, { orgId: kit.org.id, scopes: ['passes:read'] });
    const wrongKey = await makeApiKey(kit.fx, { orgId: otherOrg.id, scopes: ['passes:read'] });
    const writeKey = await makeApiKey(kit.fx, { orgId: kit.org.id, scopes: ['passes:write'] });
    const app = createApp({
      stores: {
        ...denyAllStores,
        sessions: createSessionStore(kit.env, kit.clock),
        apiKeys: createApiKeyStore(kit.env, kit.clock),
      },
      clock: kit.clock,
    });
    const url = `/api/v1/delivery?orgId=${kit.org.id}&passId=${pass.id}`;
    const response = await app.request(url, { headers: session.headers }, kit.env);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: Record<string, unknown>[] };
    expect(body.items.some((row) => row.id === outboxId)).toBe(true);
    expect(body.items.some((row) => row.id === foreignOutbox)).toBe(false);
    expect(body.items.every((row) => !('payload' in row) && !('orgId' in row))).toBe(true);
    expect((await app.request(url, { headers: readKey.headers }, kit.env)).status).toBe(200);
    expect((await app.request(url, { headers: admin.headers }, kit.env)).status).toBe(404);
    expect((await app.request(url, { headers: wrongKey.headers }, kit.env)).status).toBe(404);
    expect((await app.request(url, { headers: writeKey.headers }, kit.env)).status).toBe(403);
    expect(
      (
        await app.request(
          `/api/v1/delivery?passId=${pass.id}`,
          { headers: session.headers },
          kit.env,
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await app.request(
          `/api/v1/delivery?orgId=${otherOrg.id}&passId=${pass.id}`,
          { headers: session.headers },
          kit.env,
        )
      ).status,
    ).toBe(404);
    const testPass = await kit.pass({ mode: 'test' });
    const testUrl = `/api/v1/delivery?orgId=${kit.org.id}&passId=${testPass.id}`;
    expect((await app.request(testUrl, { headers: readKey.headers }, kit.env)).status).toBe(404);
    const prefix = kit.ctx.ids.token(6);
    const secret = `wlt_${prefix}_${kit.ctx.ids.token()}`;
    await run(
      kit.env.DB,
      `INSERT INTO api_keys
      (id,org_id,name,prefix,key_hash,scopes,mode,created_at) VALUES (?,?,'Test key',?,?,?,'test',?)`,
      [
        kit.ctx.ids.id(),
        kit.org.id,
        prefix,
        await sha256Hex(secret),
        JSON.stringify(['passes:read']),
        kit.clock.now(),
      ],
    );
    expect(
      (await app.request(testUrl, { headers: { authorization: `Bearer ${secret}` } }, kit.env))
        .status,
    ).toBe(200);
  });

  it('rechecks the current membership while reading the outbox', async () => {
    const pass = await kit.pass();
    const { outboxId } = await enqueuePassEmail(job(), {
      passId: pass.id,
      expected: pass,
      to: `${pass.id}@example.test`,
      attach: false,
    });
    const user = await makeUser(kit.fx);
    const membership = await grantKitMembership(kit, kit.org.id, user.id, ['read_only']);
    const session = await makeSession(kit.fx, { userId: user.id });
    const auth = await resolveSession(kit.env, kit.clock, session.cookieValue);
    if (!auth) throw new Error('Session fixture missing');
    const authority = await tenantAuthorityOf(kit.ctx, auth, kit.org.id, 'passes:read');
    expect(
      (await listPassDeliveries(kit.ctx, pass.id, authority)).some((row) => row.id === outboxId),
    ).toBe(true);
    await run(kit.env.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
      kit.clock.now(),
      membership,
    ]);
    expect(await listPassDeliveries(kit.ctx, pass.id, authority)).toEqual([]);
  });

  it('rechecks API key revocation while reading the outbox', async () => {
    const pass = await kit.pass();
    const { outboxId } = await enqueuePassEmail(job(), {
      passId: pass.id,
      expected: pass,
      to: `${pass.id}@example.test`,
      attach: false,
    });
    const { authority, key } = await apiAuthority('passes:read');
    expect(
      (await listPassDeliveries(kit.ctx, pass.id, authority)).some((row) => row.id === outboxId),
    ).toBe(true);
    await run(kit.env.DB, 'UPDATE api_keys SET revoked_at = ? WHERE id = ?', [
      kit.clock.now(),
      key.id,
    ]);
    expect(await listPassDeliveries(kit.ctx, pass.id, authority)).toEqual([]);
  });
});
