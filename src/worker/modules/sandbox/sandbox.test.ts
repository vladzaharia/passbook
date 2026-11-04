import { beforeAll, describe, expect, it } from 'vitest';
import { fakeAuth, makeOrg, makeUser } from '../../../../test/helpers/index.ts';
import {
  CapturedEmailDetailSchema,
  CapturedEmailListSchema,
} from '../../../shared/contracts/index.ts';
import { createApp } from '../../app.ts';
import { countQueries } from '../../jobs/query-counter.ts';
import { all, first, run } from '../../platform/db.ts';
import { handleEmailSend } from '../delivery/jobs.ts';
import { enqueuePassEmail } from '../delivery/service.ts';
import { createPassRow } from '../passes/create.ts';
import { type Kit, setupKit } from '../passes/test-kit.ts';
import { clearSettingsCache } from '../settings/service.ts';
import { dailySandbox } from './jobs.ts';

const ORIGIN = 'https://wallet.test';
const DAY = 86_400_000;
const fake = fakeAuth(ORIGIN);
let kit: Kit;
let app: ReturnType<typeof createApp>;
let other: { id: string };

beforeAll(async () => {
  kit = await setupKit();
  app = createApp({ stores: fake.stores });
  other = await makeOrg(kit.fx, { name: 'Other Org' });
  await makeUser(kit.fx, { id: 'admin-1', primaryEmail: 'admin-one@example.com' });
  await makeUser(kit.fx, { id: 'admin-2', primaryEmail: 'admin-two@example.com', verified: false });
});

type Headers = Record<string, string>;
const api = (path: string, init: RequestInit & { headers?: Headers } = {}) =>
  app.request(`${ORIGIN}/api/v1${path}`, init, kit.env);
const send = (id: string, headers: Headers = fake.admin({ mode: 'test' })) =>
  api(`/test-inbox/${id}/send-to-me`, { method: 'POST', headers });

const makePass = (mode: 'live' | 'test', orgId = kit.org.id) =>
  createPassRow(kit.ctx, {
    orgId,
    templateId: kit.template.id,
    input: { memberName: `Sandbox ${mode}` },
    source: 'manual',
    mode,
    actor: { type: 'system', id: null },
  });

async function capture(mode: 'live' | 'test', to: string, orgId = kit.org.id) {
  const pass = await makePass(mode, orgId);
  const { outboxId } = await enqueuePassEmail(kit.ctx, { passId: pass.id, to, attach: false });
  const before = kit.mailer.sent.length;
  await handleEmailSend({ kind: 'email.send', outboxId }, kit.ctx);
  return { pass, outboxId, sent: kit.mailer.sent.length - before };
}

describe('test mode mail is captured, never sent', () => {
  it('a test pass email never reaches the mailer and lands in the inbox', async () => {
    const { pass, outboxId, sent } = await capture('test', 'holder-a@example.com');
    expect(sent).toBe(0);
    const row = await first<Record<string, unknown>>(
      kit.env.DB,
      'SELECT org_id, pass_id, bundle_id, recipient, subject, html, text FROM captured_emails WHERE outbox_id = ?',
      [outboxId],
    );
    expect(row).toMatchObject({
      org_id: kit.org.id,
      pass_id: pass.id,
      bundle_id: null,
      recipient: 'holder-a@example.com',
    });
    expect(String(row?.subject).length).toBeGreaterThan(0);
    expect(String(row?.html)).toContain('<');
    expect(String(row?.text).length).toBeGreaterThan(0);
    expect(
      await first(kit.env.DB, 'SELECT state, error_code FROM outbox WHERE id = ?', [outboxId]),
    ).toEqual({ state: 'sent', error_code: 'TEST_MODE' });
  });

  it('a live pass email still goes to the mailer and is not captured', async () => {
    const { outboxId, sent } = await capture('live', 'holder-live@example.com');
    expect(sent).toBe(1);
    expect(
      await first(kit.env.DB, 'SELECT 1 AS x FROM captured_emails WHERE outbox_id = ?', [outboxId]),
    ).toBeNull();
  });

  it('handling the same row twice captures once', async () => {
    const { outboxId } = await capture('test', 'twice@example.com');
    await handleEmailSend({ kind: 'email.send', outboxId }, kit.ctx);
    const rows = await all(kit.env.DB, 'SELECT 1 FROM captured_emails WHERE outbox_id = ?', [
      outboxId,
    ]);
    expect(rows).toHaveLength(1);
  });
});

describe('GET /test-inbox', () => {
  it('lists captured mail in test mode only, newest first', async () => {
    const a = await capture('test', 'list-a@example.com');
    kit.clock.advance(10);
    const b = await capture('test', 'list-b@example.com');
    const test = CapturedEmailListSchema.parse(
      await (await api('/test-inbox?limit=200', { headers: fake.admin({ mode: 'test' }) })).json(),
    );
    const ids = test.items.map((i) => i.passId);
    expect(ids.indexOf(b.pass.id)).toBeLessThan(ids.indexOf(a.pass.id));
    expect(test.items[0]).toMatchObject({ kind: 'pass', attached: false });
    const live = CapturedEmailListSchema.parse(
      await (await api('/test-inbox', { headers: fake.admin() })).json(),
    );
    expect(live.items).toEqual([]);
  });

  it('filters by org and pages by cursor', async () => {
    const theirs = await capture('test', 'theirs@example.com', other.id);
    const mine = CapturedEmailListSchema.parse(
      await (
        await api(`/test-inbox?orgId=${kit.org.id}&limit=200`, {
          headers: fake.admin({ mode: 'test' }),
        })
      ).json(),
    );
    expect(mine.items.every((i) => i.orgId === kit.org.id)).toBe(true);
    expect(mine.items.some((i) => i.passId === theirs.pass.id)).toBe(false);
    const first1 = CapturedEmailListSchema.parse(
      await (await api('/test-inbox?limit=1', { headers: fake.admin({ mode: 'test' }) })).json(),
    );
    expect(first1.items).toHaveLength(1);
    expect(first1.nextCursor).toBe(first1.items[0]?.id);
    const second = CapturedEmailListSchema.parse(
      await (
        await api(`/test-inbox?limit=1&cursor=${first1.nextCursor}`, {
          headers: fake.admin({ mode: 'test' }),
        })
      ).json(),
    );
    expect(second.items[0]?.id).not.toBe(first1.items[0]?.id);
  });

  it('needs an admin session: users are refused, API keys have no cookie', async () => {
    expect((await api('/test-inbox', { headers: fake.user() })).status).toBe(403);
    expect((await api('/test-inbox', { headers: fake.apiKey() })).status).toBe(401);
    expect((await api('/test-inbox')).status).toBe(401);
  });

  it('returns one email with its HTML and text, in either mode', async () => {
    const { outboxId } = await capture('test', 'detail@example.com');
    const row = await first<{ id: string }>(
      kit.env.DB,
      'SELECT id FROM captured_emails WHERE outbox_id = ?',
      [outboxId],
    );
    for (const headers of [fake.admin(), fake.admin({ mode: 'test' })]) {
      const res = await api(`/test-inbox/${row?.id}`, { headers });
      expect(res.status).toBe(200);
      const body = CapturedEmailDetailSchema.parse(await res.json());
      expect(body.to).toBe('detail@example.com');
      expect(body.html.length).toBeGreaterThan(0);
    }
    expect((await api('/test-inbox/missing', { headers: fake.admin() })).status).toBe(404);
  });
});

describe('POST /test-inbox/:id/send-to-me', () => {
  it('sends to the signed-in admin only, audits it and rate limits', async () => {
    const { outboxId } = await capture('test', 'someone-else@example.com');
    const row = await first<{ id: string }>(
      kit.env.DB,
      'SELECT id FROM captured_emails WHERE outbox_id = ?',
      [outboxId],
    );
    const before = kit.mailer.sent.length;
    const res = await send(row?.id ?? '');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ to: 'admin-one@example.com' });
    expect(kit.mailer.sent).toHaveLength(before + 1);
    expect(kit.mailer.sent.at(-1)?.to).toBe('admin-one@example.com');
    expect(kit.mailer.sent.at(-1)?.subject).toMatch(/^\[Test\] /);
    const audit = await first<{ actor_id: string; target_id: string; detail: string | null }>(
      kit.env.DB,
      "SELECT actor_id, target_id, detail FROM audit_log WHERE action = 'sandbox.send_to_me' ORDER BY id DESC LIMIT 1",
    );
    expect(audit).toMatchObject({ actor_id: 'admin-1', target_id: row?.id });
    expect(audit?.detail ?? '').not.toContain('example.com');
    let limited = 0;
    for (let i = 0; i < 6; i++) if ((await send(row?.id ?? '')).status === 429) limited++;
    expect(limited).toBeGreaterThan(0);
  });

  it('refuses an admin without a verified email and an unknown id', async () => {
    const { outboxId } = await capture('test', 'x@example.com');
    const row = await first<{ id: string }>(
      kit.env.DB,
      'SELECT id FROM captured_emails WHERE outbox_id = ?',
      [outboxId],
    );
    const unverified = fake.session({ userId: 'admin-2', roles: ['admin', 'user'] });
    const res = await send(row?.id ?? '', unverified);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('NO_VERIFIED_EMAIL');
    expect((await send('missing')).status).toBe(404);
    expect((await send(row?.id ?? '', fake.user())).status).toBe(403);
  });
});

describe('daily purge', () => {
  it('deletes test passes, bundles and captured mail past sandbox.purgeDays; keeps the rest', async () => {
    const oldTest = await makePass('test');
    const oldLive = await makePass('live');
    const oldCap = await capture('test', 'old@example.com');
    await run(kit.env.DB, 'UPDATE passes SET created_at = ? WHERE id IN (?, ?, ?)', [
      kit.clock.now() - 31 * DAY,
      oldTest.id,
      oldLive.id,
      oldCap.pass.id,
    ]);
    await run(kit.env.DB, 'UPDATE captured_emails SET created_at = ? WHERE pass_id = ?', [
      kit.clock.now() - 31 * DAY,
      oldCap.pass.id,
    ]);
    const bundleId = kit.fx.ids.id();
    for (const [id, mode, age] of [
      [bundleId, 'test', 31],
      [kit.fx.ids.id(), 'test', 1],
      [kit.fx.ids.id(), 'live', 31],
    ] as const)
      await run(
        kit.env.DB,
        `INSERT INTO bundles (id, org_id, mode, name, token, created_at) VALUES (?, ?, ?, 'B', ?, ?)`,
        [id, kit.org.id, mode, kit.fx.ids.token(), kit.clock.now() - age * DAY],
      );
    const fresh = await makePass('test');
    const freshCap = await capture('test', 'fresh@example.com');
    expect(await kit.env.BUCKET.head(oldTest.objectKey)).not.toBeNull();

    await dailySandbox(kit.ctx);

    expect(await kit.env.BUCKET.head(oldTest.objectKey)).toBeNull();
    const ids = (await all<{ id: string }>(kit.env.DB, 'SELECT id FROM passes')).map((r) => r.id);
    expect(ids).not.toContain(oldTest.id);
    expect(ids).not.toContain(oldCap.pass.id);
    expect(ids).toContain(oldLive.id);
    expect(ids).toContain(fresh.id);
    expect(ids).toContain(freshCap.pass.id);
    expect(await kit.env.BUCKET.head(oldLive.objectKey)).not.toBeNull();
    expect(
      await first(kit.env.DB, 'SELECT 1 AS x FROM captured_emails WHERE pass_id = ?', [
        oldCap.pass.id,
      ]),
    ).toBeNull();
    expect(
      await first(kit.env.DB, 'SELECT 1 AS x FROM captured_emails WHERE pass_id = ?', [
        freshCap.pass.id,
      ]),
    ).not.toBeNull();
    const bundles = await all<{ id: string; mode: string }>(
      kit.env.DB,
      'SELECT id, mode FROM bundles',
    );
    expect(bundles.map((b) => b.id)).not.toContain(bundleId);
    expect(bundles.filter((b) => b.mode === 'live')).toHaveLength(1);
    expect(bundles.filter((b) => b.mode === 'test')).toHaveLength(1);
  });

  it('follows the setting and runs in bounded rounds', async () => {
    await run(kit.env.DB, 'DELETE FROM settings WHERE key = ?', ['sandbox.purgeDays']);
    await run(
      kit.env.DB,
      "INSERT INTO settings (scope, key, value, updated_at) VALUES ('platform', 'sandbox.purgeDays', '2', ?)",
      [kit.clock.now()],
    );
    clearSettingsCache(kit.env.DB);
    const three = await makePass('test');
    await run(kit.env.DB, 'UPDATE passes SET created_at = ? WHERE id = ?', [
      kit.clock.now() - 3 * DAY,
      three.id,
    ]);
    await dailySandbox(kit.ctx);
    expect(
      await first(kit.env.DB, 'SELECT 1 AS x FROM passes WHERE id = ?', [three.id]),
    ).toBeNull();
    await run(kit.env.DB, 'DELETE FROM settings WHERE key = ?', ['sandbox.purgeDays']);
    clearSettingsCache(kit.env.DB);
  });

  it('stays inside a fixed query count with a backlog', async () => {
    const old = kit.clock.now() - 40 * DAY;
    for (let i = 0; i < 90; i++) {
      const pass = await makePass('test');
      await run(kit.env.DB, 'UPDATE passes SET created_at = ? WHERE id = ?', [old, pass.id]);
    }
    const counter = countQueries(kit.env);
    await dailySandbox({ ...kit.ctx, env: counter.env });
    expect(counter.count()).toBeLessThan(400);
    const left = await first<{ n: number }>(
      kit.env.DB,
      "SELECT COUNT(*) AS n FROM passes WHERE mode = 'test' AND created_at = ?",
      [old],
    );
    expect(left?.n).toBeGreaterThan(0);
  });
});
