import type { OpenAPIHono } from '@hono/zod-openapi';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  makeApiKey,
  makeOrg,
  makeSession,
  makeUser,
  type SessionFixture,
} from '../../../../test/helpers/index.ts';
import {
  CapturedEmailDetailSchema,
  CapturedEmailListSchema,
} from '../../../shared/contracts/index.ts';
import type { AppBindings } from '../../platform/context.ts';
import { all, first, run } from '../../platform/db.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { hashSessionCookie } from '../auth/sessions.ts';
import { fakeLimiter } from '../auth/test-support.ts';
import { bindPass } from '../delivery/binding.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import {
  captureInboxPass,
  grantInboxMembership,
  inboxApp,
  inboxHeaders,
  inboxMember,
  scopedInboxPath,
} from './test-tenant-fixtures.ts';

const ORIGIN = 'https://wallet.test';
let kit: Kit;
let app: OpenAPIHono<AppBindings>;
let otherOrg: string;

beforeAll(async () => {
  kit = await setupKit();
  kit.env.RL_REFRESH = fakeLimiter(1000) as unknown as RateLimit;
  app = inboxApp(kit);
  otherOrg = (await makeOrg(kit.fx, { name: 'Other inbox tenant' })).id;
});

function request(path: string, session: SessionFixture, orgId = kit.org.id, method = 'GET') {
  return app.request(
    `${ORIGIN}/api/v1${scopedInboxPath(path, orgId)}`,
    {
      method,
      headers: inboxHeaders(session),
    },
    kit.env,
  );
}

async function member(
  role: 'read_only' | 'pass_operator' | 'template_author' | 'org_admin' = 'pass_operator',
) {
  const user = await makeUser(kit.fx);
  return { user, ...(await inboxMember(kit, user.id, kit.org.id, role)) };
}

async function noEffects(captureId: string, sentBefore: number) {
  expect(
    await all(kit.env.DB, 'SELECT id FROM sandbox_forwards WHERE capture_id = ?', [captureId]),
  ).toEqual([]);
  expect(
    await all(
      kit.env.DB,
      "SELECT id FROM audit_log WHERE action = 'sandbox.send_to_me' AND target_id = ?",
      [captureId],
    ),
  ).toEqual([]);
  expect(kit.mailer.sent).toHaveLength(sentBefore);
}

describe('tenant Test inbox routes', () => {
  it('requires explicit org selection and never treats a platform administrator as a member', async () => {
    const capture = await captureInboxPass(kit);
    const before = kit.mailer.sent.length;
    const user = await makeUser(kit.fx);
    const admin = await makeSession(kit.fx, { userId: user.id, roles: ['admin', 'user'] });
    for (const path of [
      '/test-inbox',
      `/test-inbox/${capture.id}`,
      `/test-inbox/${capture.id}/send-to-me`,
    ]) {
      const method = path.endsWith('/send-to-me') ? 'POST' : 'GET';
      const response = await app.request(
        `${ORIGIN}/api/v1${path}`,
        {
          method,
          headers: inboxHeaders(admin),
        },
        kit.env,
      );
      expect(response.status, path).toBe(422);
    }
    const emptyOrg = await app.request(
      `${ORIGIN}/api/v1/test-inbox?orgId=`,
      {
        headers: inboxHeaders(admin),
      },
      kit.env,
    );
    expect(emptyOrg.status).toBe(422);
    const list = await request('/test-inbox', admin);
    expect(list.status).toBe(200);
    expect(CapturedEmailListSchema.parse(await list.json()).items).toEqual([]);
    for (const path of [
      `/test-inbox/${capture.id}`,
      `/test-inbox/${capture.id}/html`,
      `/test-inbox/${capture.id}/send-to-me`,
    ]) {
      const res = await request(
        path,
        admin,
        kit.org.id,
        path.endsWith('/send-to-me') ? 'POST' : 'GET',
      );
      expect(res.status, path).toBe(404);
      const body = await res.text();
      expect(body).not.toContain(capture.recipient);
      expect(body).not.toContain(capture.html);
    }
    await noEffects(capture.id, before);
  }, 60_000);

  it('lets read-only members preview but reserves sending for pass operators', async () => {
    const capture = await captureInboxPass(kit);
    const before = kit.mailer.sent.length;
    const reader = await member('read_only');
    const operator = await member('pass_operator');
    const author = await member('template_author');
    const list = await request('/test-inbox?limit=200', reader.session);
    expect(CapturedEmailListSchema.parse(await list.json()).items.map((item) => item.id)).toContain(
      capture.id,
    );
    const detail = await request(`/test-inbox/${capture.id}`, reader.session);
    expect(detail.status).toBe(200);
    expect(CapturedEmailDetailSchema.parse(await detail.json())).toMatchObject({
      id: capture.id,
      orgId: kit.org.id,
      to: capture.recipient,
      html: capture.html,
      text: capture.text,
    });
    const preview = await request(`/test-inbox/${capture.id}/html`, reader.session);
    expect(preview.status).toBe(200);
    expect(await preview.text()).toBe(capture.html);
    expect(
      (await request(`/test-inbox/${capture.id}/send-to-me`, reader.session, kit.org.id, 'POST'))
        .status,
    ).toBe(404);
    expect(
      CapturedEmailListSchema.parse(await (await request('/test-inbox', author.session)).json())
        .items,
    ).toEqual([]);
    expect((await request(`/test-inbox/${capture.id}`, author.session)).status).toBe(404);
    await noEffects(capture.id, before);
    const sent = await request(
      `/test-inbox/${capture.id}/send-to-me`,
      operator.session,
      kit.org.id,
      'POST',
    );
    expect(sent.status).toBe(200);
    expect(await sent.json()).toEqual({ to: operator.user.primaryEmail });
    expect(kit.mailer.sent).toHaveLength(before + 1);
    expect(kit.mailer.sent.at(-1)?.to).toBe(operator.user.primaryEmail);
    expect(
      await first(
        kit.env.DB,
        'SELECT actor_id, org_id, state FROM sandbox_forwards WHERE capture_id = ?',
        [capture.id],
      ),
    ).toEqual({ actor_id: operator.user.id, org_id: kit.org.id, state: 'sent' });
    expect(
      await first(
        kit.env.DB,
        "SELECT actor_id, org_id, detail FROM audit_log WHERE action = 'sandbox.send_to_me' AND target_id = ?",
        [capture.id],
      ),
    ).toEqual({ actor_id: operator.user.id, org_id: kit.org.id, detail: null });
  }, 60_000);

  it('uses the actual capture org and hides foreign, missing, and non-Test captures', async () => {
    const actor = await member();
    await grantInboxMembership(kit, actor.user.id, otherOrg, 'pass_operator');
    const own = await captureInboxPass(kit);
    const foreign = await captureInboxPass(kit, otherOrg);
    const recipient = `${kit.fx.ids.token(10).toLowerCase()}@example.com`;
    const livePass = await kit.pass({ mode: 'live', holderEmail: recipient });
    const live = { id: kit.fx.ids.id(), recipient, html: '<p>Private live email</p>' };
    // An inconsistent historical capture claiming Test mode must not expose a Live pass.
    const binding = { ...(await bindPass(livePass)), mode: 'test' };
    await run(
      kit.env.DB,
      `INSERT INTO captured_emails
      (id, org_id, pass_id, recipient, subject, html, text, attached, intent, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [
        live.id,
        kit.org.id,
        livePass.id,
        live.recipient,
        'Private',
        live.html,
        'Private live email',
        JSON.stringify({ format: 1, to: recipient, attach: false, pass: binding }),
        kit.clock.now(),
      ],
    );
    const before = kit.mailer.sent.length;
    const list = CapturedEmailListSchema.parse(
      await (await request('/test-inbox?limit=200', actor.session)).json(),
    );
    expect(list.items.map((item) => item.id)).toContain(own.id);
    expect(list.items.map((item) => item.id)).not.toContain(foreign.id);
    expect(list.items.map((item) => item.id)).not.toContain(live.id);
    const otherList = CapturedEmailListSchema.parse(
      await (await request('/test-inbox?limit=200', actor.session, otherOrg)).json(),
    );
    expect(otherList.items.map((item) => item.id)).toContain(foreign.id);
    expect(otherList.items.map((item) => item.id)).not.toContain(own.id);
    expect((await request(`/test-inbox/${foreign.id}`, actor.session, otherOrg)).status).toBe(200);
    const missing = kit.fx.ids.id();
    for (const id of [foreign.id, live.id, missing]) {
      for (const suffix of ['', '/html', '/send-to-me']) {
        const response = await request(
          `/test-inbox/${id}${suffix}`,
          actor.session,
          kit.org.id,
          suffix === '/send-to-me' ? 'POST' : 'GET',
        );
        expect(response.status, `${id}${suffix}`).toBe(404);
        const body = await response.text();
        expect(JSON.parse(body)).toMatchObject({ code: 'CAPTURED_EMAIL_NOT_FOUND' });
        expect(body).not.toContain(foreign.recipient);
        expect(body).not.toContain(foreign.html);
        expect(body).not.toContain(live.recipient);
      }
    }
    await noEffects(foreign.id, before);
    await noEffects(live.id, before);
  }, 60_000);

  it('requires Test mode, with an explicit mode query for the iframe', async () => {
    const actor = await member();
    const capture = await captureInboxPass(kit);
    const before = kit.mailer.sent.length;
    const base = `${ORIGIN}/api/v1/test-inbox/${capture.id}`;
    const org = encodeURIComponent(kit.org.id);
    const liveHeaders = actor.session.headers;
    expect(
      CapturedEmailListSchema.parse(
        await (
          await app.request(
            `${ORIGIN}/api/v1/test-inbox?orgId=${org}`,
            { headers: liveHeaders },
            kit.env,
          )
        ).json(),
      ).items,
    ).toEqual([]);
    expect(
      (await app.request(`${base}?orgId=${org}`, { headers: liveHeaders }, kit.env)).status,
    ).toBe(404);
    expect(
      (await app.request(`${base}?orgId=${org}&mode=test`, { headers: liveHeaders }, kit.env))
        .status,
    ).toBe(200);
    expect(
      (
        await app.request(
          `${base}?orgId=${org}&mode=live`,
          { headers: inboxHeaders(actor.session) },
          kit.env,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await app.request(
          `${base}/html?orgId=${org}`,
          { headers: inboxHeaders(actor.session) },
          kit.env,
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await app.request(
          `${base}/html?orgId=${org}&mode=invalid`,
          { headers: liveHeaders },
          kit.env,
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await app.request(
          `${base}/html?orgId=${org}&mode=live`,
          { headers: inboxHeaders(actor.session) },
          kit.env,
        )
      ).status,
    ).toBe(404);
    expect(
      (await app.request(`${base}/html?orgId=${org}&mode=test`, { headers: liveHeaders }, kit.env))
        .status,
    ).toBe(200);
    expect(
      (
        await app.request(
          `${base}/send-to-me?orgId=${org}`,
          {
            method: 'POST',
            headers: liveHeaders,
          },
          kit.env,
        )
      ).status,
    ).toBe(404);
    await noEffects(capture.id, before);
  }, 60_000);

  it('enforces verified email independently of tenant access', async () => {
    const user = await makeUser(kit.fx, { verified: false });
    const actor = await inboxMember(kit, user.id, kit.org.id, 'pass_operator');
    const capture = await captureInboxPass(kit);
    const before = kit.mailer.sent.length;
    expect((await request(`/test-inbox/${capture.id}`, actor.session)).status).toBe(200);
    const response = await request(
      `/test-inbox/${capture.id}/send-to-me`,
      actor.session,
      kit.org.id,
      'POST',
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: 'NO_VERIFIED_EMAIL' });
    await noEffects(capture.id, before);
  }, 60_000);

  it('rejects revoked memberships and sessions and never permits API keys', async () => {
    const capture = await captureInboxPass(kit);
    const before = kit.mailer.sent.length;
    const revokedMember = await member();
    await run(kit.env.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
      kit.clock.now(),
      revokedMember.membershipId,
    ]);
    expect(
      CapturedEmailListSchema.parse(
        await (await request('/test-inbox', revokedMember.session)).json(),
      ).items,
    ).toEqual([]);
    expect((await request(`/test-inbox/${capture.id}`, revokedMember.session)).status).toBe(404);
    expect(
      (
        await request(
          `/test-inbox/${capture.id}/send-to-me`,
          revokedMember.session,
          kit.org.id,
          'POST',
        )
      ).status,
    ).toBe(404);
    const revokedSession = await member();
    await run(kit.env.DB, 'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?', [
      kit.clock.now(),
      await hashSessionCookie(revokedSession.session.cookieValue),
    ]);
    expect((await request('/test-inbox', revokedSession.session)).status).toBe(401);
    expect(
      (
        await request(
          `/test-inbox/${capture.id}/send-to-me`,
          revokedSession.session,
          kit.org.id,
          'POST',
        )
      ).status,
    ).toBe(401);
    const key = await makeApiKey(kit.fx, {
      orgId: kit.org.id,
      scopes: ['passes:read', 'passes:write'],
      mode: 'test',
    });
    const keys = createApiKeyStore(kit.env, kit.clock);
    expect(await keys.resolve(key.secret)).toMatchObject({
      kind: 'api_key',
      orgId: kit.org.id,
      mode: 'test',
    });
    const rawKey = { ...key.headers, 'x-passbook-mode': 'test' };
    for (const suffix of [
      '',
      `/${capture.id}`,
      `/${capture.id}/html`,
      `/${capture.id}/send-to-me`,
    ]) {
      const path = scopedInboxPath(`/test-inbox${suffix}`, kit.org.id);
      const res = await app.request(
        `${ORIGIN}/api/v1${path}`,
        {
          method: suffix.endsWith('/send-to-me') ? 'POST' : 'GET',
          headers: rawKey,
        },
        kit.env,
      );
      expect(res.status).toBe(401);
    }
    await run(kit.env.DB, 'UPDATE api_keys SET revoked_at = ? WHERE id = ?', [
      kit.clock.now(),
      key.id,
    ]);
    expect(await keys.resolve(key.secret)).toBeNull();
    const denied = await app.request(
      `${ORIGIN}/api/v1${scopedInboxPath(`/test-inbox/${capture.id}/send-to-me`, kit.org.id)}`,
      { method: 'POST', headers: rawKey },
      kit.env,
    );
    expect(denied.status).toBe(401);
    await noEffects(capture.id, before);
  }, 60_000);
});
