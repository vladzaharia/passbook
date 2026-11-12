import type { OpenAPIHono } from '@hono/zod-openapi';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  editFixedColumns,
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
import { countQueries } from '../../jobs/query-counter.ts';
import type { AppBindings } from '../../platform/context.ts';
import { all, first, run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { enqueuePassEmail } from '../delivery/issuance-intent.ts';
import { handleEmailSend } from '../delivery/jobs.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import { clearSettingsCache } from '../settings/service.ts';
import { dailySandbox } from './jobs.ts';
import { inboxApp, inboxHeaders, inboxMember, scopedInboxPath } from './test-tenant-fixtures.ts';

const ORIGIN = 'https://wallet.test';
const DAY = 86_400_000;
let admin: SessionFixture;
let unverified: SessionFixture;
let outsider: SessionFixture;
let keyHeaders: Record<string, string>;
let kit: Kit;
let app: OpenAPIHono<AppBindings>;
let other: { id: string };

beforeAll(async () => {
  kit = await setupKit();
  app = inboxApp(kit);
  other = await makeOrg(kit.fx, { name: 'Other Org' });
  const first = await makeUser(kit.fx, { id: 'admin-1', primaryEmail: 'admin-one@example.com' });
  const second = await makeUser(kit.fx, {
    id: 'admin-2',
    primaryEmail: 'admin-two@example.com',
    verified: false,
  });
  admin = (await inboxMember(kit, first.id, kit.org.id, 'org_admin', ['admin', 'user'])).session;
  unverified = (await inboxMember(kit, second.id)).session;
  const user = await makeUser(kit.fx);
  outsider = await makeSession(kit.fx, { userId: user.id });
  keyHeaders = (await makeApiKey(kit.fx, { orgId: kit.org.id })).headers;
});

type Headers = Record<string, string>;
const api = (path: string, init: RequestInit & { headers?: Headers } = {}) =>
  app.request(`${ORIGIN}/api/v1${scopedInboxPath(path, kit.org.id)}`, init, kit.env);
const send = (id: string, headers: Headers = inboxHeaders(admin)) =>
  api(`/test-inbox/${id}/send-to-me`, { method: 'POST', headers });

const makePass = (mode: 'live' | 'test', orgId = kit.org.id) =>
  kit.pass({ orgId, mode, memberName: `Sandbox ${mode}` });

async function capture(mode: 'live' | 'test', to: string, orgId = kit.org.id) {
  const pass = await makePass(mode, orgId);
  const { outboxId } = await enqueuePassEmail(jobCtxOf(kit), {
    passId: pass.id,
    to,
    attach: false,
    expected: pass,
  });
  const before = kit.mailer.sent.length;
  await handleEmailSend({ kind: 'email.send', outboxId }, jobCtxOf(kit));
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
    await handleEmailSend({ kind: 'email.send', outboxId }, jobCtxOf(kit));
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
      await (await api('/test-inbox?limit=200', { headers: inboxHeaders(admin) })).json(),
    );
    const ids = test.items.map((i) => i.passId);
    expect(ids.indexOf(b.pass.id)).toBeLessThan(ids.indexOf(a.pass.id));
    expect(test.items[0]).toMatchObject({ kind: 'pass', attached: false });
    const live = CapturedEmailListSchema.parse(
      await (await api('/test-inbox', { headers: admin.headers })).json(),
    );
    expect(live.items).toEqual([]);
  });

  it('filters by org and pages by cursor', async () => {
    const theirs = await capture('test', 'theirs@example.com', other.id);
    const mine = CapturedEmailListSchema.parse(
      await (
        await api(`/test-inbox?orgId=${kit.org.id}&limit=200`, {
          headers: inboxHeaders(admin),
        })
      ).json(),
    );
    expect(mine.items.every((i) => i.orgId === kit.org.id)).toBe(true);
    expect(mine.items.some((i) => i.passId === theirs.pass.id)).toBe(false);
    const first1 = CapturedEmailListSchema.parse(
      await (await api('/test-inbox?limit=1', { headers: inboxHeaders(admin) })).json(),
    );
    expect(first1.items).toHaveLength(1);
    expect(first1.nextCursor).toBe(first1.items[0]?.id);
    const second = CapturedEmailListSchema.parse(
      await (
        await api(`/test-inbox?limit=1&cursor=${first1.nextCursor}`, {
          headers: inboxHeaders(admin),
        })
      ).json(),
    );
    expect(second.items[0]?.id).not.toBe(first1.items[0]?.id);
  });

  it('requires a member session; API keys cannot access the inbox', async () => {
    expect(
      CapturedEmailListSchema.parse(
        await (await api('/test-inbox', { headers: inboxHeaders(outsider) })).json(),
      ).items,
    ).toEqual([]);
    expect(
      (await api('/test-inbox', { headers: { ...keyHeaders, 'x-passbook-mode': 'test' } })).status,
    ).toBe(401);
    expect((await api('/test-inbox')).status).toBe(401);
  });

  it('returns one email with its HTML and text only in Test mode', async () => {
    const { outboxId } = await capture('test', 'detail@example.com');
    const row = await first<{ id: string }>(
      kit.env.DB,
      'SELECT id FROM captured_emails WHERE outbox_id = ?',
      [outboxId],
    );
    const res = await api(`/test-inbox/${row?.id}`, { headers: inboxHeaders(admin) });
    expect(res.status).toBe(200);
    const body = CapturedEmailDetailSchema.parse(await res.json());
    expect(body.to).toBe('detail@example.com');
    expect(body.html.length).toBeGreaterThan(0);
    expect((await api(`/test-inbox/${row?.id}`, { headers: admin.headers })).status).toBe(404);
    expect((await api('/test-inbox/missing', { headers: inboxHeaders(admin) })).status).toBe(404);
  });
});

describe('POST /test-inbox/:id/send-to-me', () => {
  it('sends a captured email to the verified admin address', async () => {
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
    const detail = CapturedEmailDetailSchema.parse(
      await (await api(`/test-inbox/${row?.id}`, { headers: inboxHeaders(admin) })).json(),
    );
    expect(detail.forwarding).toBe('sent');
    expect(
      await first(
        kit.env.DB,
        `SELECT actor_id, detail FROM audit_log
       WHERE action = 'sandbox.send_to_me' AND target_id = ?`,
        [row?.id],
      ),
    ).toEqual({ actor_id: 'admin-1', detail: null });
  });

  it('refuses a member without a verified email and an unknown id', async () => {
    const { outboxId } = await capture('test', 'x@example.com');
    const row = await first<{ id: string }>(
      kit.env.DB,
      'SELECT id FROM captured_emails WHERE outbox_id = ?',
      [outboxId],
    );
    const res = await send(row?.id ?? '', inboxHeaders(unverified));
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('NO_VERIFIED_EMAIL');
    expect((await send('missing')).status).toBe(404);
    expect((await send(row?.id ?? '', inboxHeaders(outsider))).status).toBe(404);
  });
});

describe('daily purge', () => {
  it('deletes test passes, bundles and captured mail past sandbox.purgeDays; keeps the rest', async () => {
    const oldTest = await makePass('test');
    const oldLive = await makePass('live');
    const oldCap = await capture('test', 'old@example.com');
    await editFixedColumns(
      kit.env.DB,
      'passes',
      'UPDATE passes SET created_at = ? WHERE id IN (?, ?, ?)',
      [kit.clock.now() - 31 * DAY, oldTest.id, oldLive.id, oldCap.pass.id],
    );
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

    await dailySandbox(jobCtxOf(kit));

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
    await editFixedColumns(kit.env.DB, 'passes', 'UPDATE passes SET created_at = ? WHERE id = ?', [
      kit.clock.now() - 3 * DAY,
      three.id,
    ]);
    await dailySandbox(jobCtxOf(kit));
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
      await editFixedColumns(
        kit.env.DB,
        'passes',
        'UPDATE passes SET created_at = ? WHERE id = ?',
        [old, pass.id],
      );
    }
    const counter = countQueries(kit.env);
    await dailySandbox({ ...jobCtxOf(kit), env: counter.env });
    expect(counter.count()).toBeLessThan(400);
    const left = await first<{ n: number }>(
      kit.env.DB,
      "SELECT COUNT(*) AS n FROM passes WHERE mode = 'test' AND created_at = ?",
      [old],
    );
    expect(left?.n).toBeGreaterThan(0);
    // Creating 90 passes is the slow part; under a loaded runner it outlasts the 5 s default.
  }, 60_000);
});

describe('GET /test-inbox/{id}/html', () => {
  it('serves the email with its own policy and the app policy untouched', async () => {
    const { outboxId } = await capture('test', 'frame@example.com');
    const row = await first<{ id: string; html: string }>(
      kit.env.DB,
      'SELECT id, html FROM captured_emails WHERE outbox_id = ?',
      [outboxId],
    );
    const res = await api(`/test-inbox/${row?.id}/html`, { headers: admin.headers });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('content-security-policy')).toBe(
      "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data: https:; frame-ancestors 'self'",
    );
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(await res.text()).toBe(row?.html);
    const json = await api(`/test-inbox/${row?.id}`, { headers: inboxHeaders(admin) });
    expect(json.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(json.headers.get('content-security-policy')).not.toContain("style-src 'unsafe-inline'");
  });

  it('hides unknown ids from a member and a non-member', async () => {
    expect((await api('/test-inbox/nope/html', { headers: admin.headers })).status).toBe(404);
    expect((await api('/test-inbox/nope/html', { headers: outsider.headers })).status).toBe(404);
  });
});

describe('capture ledger', () => {
  it('records email.captured once when the row is handled twice', async () => {
    const { pass, outboxId } = await capture('test', 'ledger@example.com');
    await run(kit.env.DB, "UPDATE outbox SET state = 'enqueued' WHERE id = ?", [outboxId]);
    await handleEmailSend({ kind: 'email.send', outboxId }, jobCtxOf(kit));
    const events = await all(
      kit.env.DB,
      "SELECT 1 FROM pass_events WHERE pass_id = ? AND kind = 'email.captured'",
      [pass.id],
    );
    expect(events).toHaveLength(1);
  });
});
