import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { linkToken, persistTemplate } from '../../../../test/helpers/index.ts';
import { makeJoinLink } from '../../../../test/helpers/join.ts';
import { issueToken, revealToken } from '../../platform/capability-token.ts';
import { all, first, run } from '../../platform/db.ts';
import { fakeLimiter } from '../auth/test-support.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { handleEmailSend, sweepDelivery } from '../delivery/jobs.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { TINY_PNG } from '../passes/pass-test-fixtures.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { handleJoinResend } from './jobs.ts';
import { joinTemplate } from './join-test-fixtures.ts';
import {
  type Jar,
  type PublicKit,
  publicKit,
  turnstile,
  verdictOf,
} from './public-test-fixtures.ts';

let t: PublicKit;
let n = 0;
beforeAll(async () => {
  t = await publicKit();
}, 120_000);
afterAll(() => t.restore());
beforeEach(async () => {
  // The platform breaker counts a UTC day: each test starts from its own count.
  await run(t.kit.env.DB, "DELETE FROM counters WHERE key = 'join:platform'");
  turnstile.verdict = verdictOf();
  turnstile.asked.length = 0;
});

const db = () => t.kit.env.DB;

/** A platform setting for the length of `fn`, put back whatever `fn` does. */
async function withSetting(key: string, value: string, fn: () => Promise<void>) {
  const { clearSettingsCache } = await import('../settings/service.ts');
  await run(
    db(),
    "INSERT OR REPLACE INTO settings (scope, key, value, updated_at) VALUES ('platform', ?, ?, 1)",
    [key, value],
  );
  clearSettingsCache(db());
  try {
    await fn();
  } finally {
    await run(db(), "DELETE FROM settings WHERE scope = 'platform' AND key = ?", [key]);
    clearSettingsCache(db());
  }
}
const passCount = async () =>
  (await first<{ n: number }>(db(), 'SELECT COUNT(*) AS n FROM passes'))?.n ?? 0;
const issues = (linkId: string) =>
  all<{
    pass_id: string;
    ip_key: string | null;
    device_key: string | null;
    fields_hash: string | null;
  }>(db(), 'SELECT pass_id, ip_key, device_key, fields_hash FROM join_issues WHERE link_id = ?', [
    linkId,
  ]);
const email = () => `guest-${n++}-${t.kit.fx.ids.token(4).toLowerCase()}@example.com`;
const resends = () =>
  (t.kit.queue.sent as { kind: string; passId?: string }[]).filter((m) => m.kind === 'join.resend');
const outboxOf = async (passId: string) =>
  (
    await first<{ id: string }>(
      db(),
      "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'email'",
      [passId],
    )
  )?.id ?? '';

async function cardOf(res: Response) {
  // With an address the page is "Check your email"; the card is only in the mail.
  expect([200, 303]).toContain(res.status);
  const row = await first<{ id: string }>(
    db(),
    'SELECT id FROM passes WHERE id = (SELECT pass_id FROM join_issues ORDER BY created_at DESC, rowid DESC LIMIT 1)',
  );
  const pass = row ? await getPass(db(), row.id) : null;
  const token = pass
    ? await revealToken(t.kit.env, 'pass', pass.id, pass.orgId, pass.downloadToken)
    : '';
  return { token, passId: row?.id ?? '' };
}

describe('POST /j/:token: a new card', () => {
  it('makes the card, answers 303 to /p/:token and sets the device cookie', async () => {
    const l = await t.link({ askEmail: false });
    const page = await t.get(l);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('First name');
    expect(html).not.toContain('/p/');
    const jar: Jar = new Map();
    const res = await t.post(l, { name: 'Sam' }, { jar });
    const { token, passId } = await cardOf(res);
    const pass = await getPass(db(), passId);
    expect(pass).toMatchObject({ ownerUserId: null, mode: 'live', orgId: t.kit.org.id });
    expect(await linkToken(t.kit.env, pass ?? { id: '', orgId: '', downloadToken: '' })).toBe(
      token,
    );
    expect(pass?.personalization).toEqual({ memberName: 'Sam' });
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith('__Host-pb_join='));
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Max-Age=86400/i);
    expect(cookie).toMatch(/Path=\//i);
    expect(jar.get('__Host-pb_join')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The ledger holds digests, never the cookie, the network or the fields.
    const [row] = await issues(l.id);
    for (const key of [row?.ip_key, row?.device_key, row?.fields_hash])
      expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(row?.device_key).not.toBe(jar.get('__Host-pb_join'));
    expect(turnstile.asked).toEqual(['tok']);
  });

  it('builds the barcode from the scan code and takes nothing but the allowed inputs', async () => {
    const l = await t.link({ askEmail: false });
    const { passId } = await cardOf(await t.post(l, { name: 'Alex' }));
    const stored = await first<{ pass_json: string; scan_code: string }>(
      db(),
      'SELECT a.pass_json, p.scan_code FROM passes p JOIN pass_artifacts a ON a.pass_id = p.id AND a.version = p.version WHERE p.id = ?',
      [passId],
    ).catch(() => null);
    if (stored) {
      const pass = JSON.parse(stored.pass_json) as { barcodes?: { message: string }[] };
      expect(pass.barcodes?.[0]?.message).toBe(stored.scan_code);
    }
    const row = await first<{ scan_code: string; personalization: string }>(
      db(),
      'SELECT scan_code, personalization FROM passes WHERE id = ?',
      [passId],
    );
    expect(Object.keys(JSON.parse(row?.personalization ?? '{}'))).toEqual(['memberName']);
    expect(row?.scan_code).toMatch(/^[A-Z2-7]{26}$/);
  });

  it('refuses extra fields, repeated fields and fields the link does not ask for', async () => {
    const l = await t.link({ askEmail: false });
    const before = await passCount();
    for (const extra of [{ role: 'admin' }, { sample: 'x' }, { 'pass.scanCode': '1' }] as Record<
      string,
      string
    >[]) {
      const res = await t.post(l, extra);
      expect(res.status).toBe(422);
      expect(await res.text()).toContain('Check the form');
    }
    // Repeated field and an email the link never asked for.
    expect((await t.post(l, {}, { body: 'name=A&name=B&cf-turnstile-response=tok' })).status).toBe(
      422,
    );
    expect((await t.post(l, { email: 'a@example.com' })).status).toBe(422);
    // Name missing.
    const missing = await t.post(l, { name: null });
    expect(missing.status).toBe(422);
    expect(await missing.text()).toContain('Enter your first name.');
    expect(await passCount()).toBe(before);
    expect(turnstile.asked).toEqual([]);
  });

  it('refuses names with bidi, control, zero-width, link or address characters', async () => {
    const l = await t.link({ askEmail: false });
    const before = await passCount();
    for (const name of [
      'Sam‮evil',
      'Sam\u0007',
      'Sa​m',
      'www.example.com',
      'http://x.test',
      'a@b.co',
      ' ',
      'x'.repeat(41),
      'ｗｗｗ．ｅｘａｍｐｌｅ．ｃｏｍ',
    ])
      expect((await t.post(l, { name })).status, name).toBe(422);
    expect(await passCount()).toBe(before);
    // The name is kept in the form, escaped.
    const kept = await t.post(l, { name: '<b>x</b>@' });
    expect(kept.status).toBe(422);
    const html = await kept.text();
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;@');
    expect(html).not.toContain('<b>x</b>');
  });

  it('refuses an Origin from another site (403) and a body over 4 KB (413)', async () => {
    const l = await t.link({ askEmail: false });
    const before = await passCount();
    const foreign = await t.post(l, {}, { headers: { origin: 'https://evil.example' } });
    expect(foreign.status).toBe(403);
    const big = await t.post(l, { name: 'x'.repeat(5000) });
    expect(big.status).toBe(413);
    const wrongType = await t.post(
      l,
      {},
      { headers: { 'content-type': 'application/json' }, body: '{}' },
    );
    expect(wrongType.status).toBe(415);
    // An absent Origin is allowed; Turnstile still applies.
    const bare = await t.app.request(
      `https://passbook.mobile/j/${l.token}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'cf-connecting-ip': '203.0.113.9',
        },
        body: 'name=Sam&cf-turnstile-response=tok',
      },
      t.kit.env,
    );
    expect(bare.status).toBe(303);
    expect(await passCount()).toBe(before + 1);
  });

  it('writes no name, email, token or address to the logs, the audit rows or the events', async () => {
    const l = await t.link();
    const spies = (['log', 'info', 'warn', 'error'] as const).map((level) =>
      vi.spyOn(console, level),
    );
    const addr = email();
    const secretName = 'Zebulon';
    const res = await t.post(l, { name: secretName, email: addr }, { ip: '198.51.100.77' });
    // Also a refusal path, so its log lines are read too.
    turnstile.verdict = { success: false };
    await t.post(l, { name: secretName, email: email() }, { ip: '198.51.100.77', jar: new Map() });
    turnstile.verdict = verdictOf();
    const { token } = await cardOf(res);
    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    for (const secret of [secretName, addr, token, l.token, '198.51.100'])
      expect(logged).not.toContain(secret);
    expect(logged).toContain('JOIN_TURNSTILE_FAILED');
    const rows = JSON.stringify(
      await all(
        db(),
        "SELECT detail, actor_id, ip_prefix FROM audit_log WHERE action = 'pass.create' AND actor_id = ?",
        [`join:${l.id}`],
      ),
    );
    for (const secret of [secretName, addr, token, l.token, '198.51.100'])
      expect(rows).not.toContain(secret);
    expect(rows).toContain(`join:${l.id}`);
    const events = JSON.stringify(
      await all(db(), "SELECT data FROM pass_events WHERE kind = 'pass.issued' AND actor_id = ?", [
        `join:${l.id}`,
      ]),
    );
    expect(events).not.toContain(addr);
    expect(events).not.toContain(secretName);
  });
});

describe('POST /j/:token: Turnstile', () => {
  it('refuses a missing token, a wrong action, a wrong host and a failed verdict', async () => {
    const l = await t.link({ askEmail: false });
    const before = await passCount();
    expect((await t.post(l, { 'cf-turnstile-response': null })).status).toBe(403);
    expect(turnstile.asked).toEqual([]);
    turnstile.verdict = verdictOf({ action: 'magic_request' });
    const wrongAction = await t.post(l);
    expect(wrongAction.status).toBe(403);
    expect(await wrongAction.text()).toContain('Verification failed. Try again.');
    turnstile.verdict = verdictOf({ hostname: 'evil.example' });
    expect((await t.post(l)).status).toBe(403);
    turnstile.verdict = { success: false };
    expect((await t.post(l)).status).toBe(403);
    expect(await passCount()).toBe(before);
    expect(turnstile.asked.length).toBe(3);
  });

  it('is refused when Turnstile is not configured or does not answer', async () => {
    const l = await t.link({ askEmail: false });
    const before = await passCount();
    const unconfigured = await t.post(
      l,
      {},
      { env: { ...t.kit.env, TURNSTILE_SECRET: undefined as never } },
    );
    expect(unconfigured.status).toBe(403);
    const real = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('down');
    }) as typeof fetch;
    try {
      expect((await t.post(l)).status).toBe(403);
    } finally {
      globalThis.fetch = real;
    }
    expect(await passCount()).toBe(before);
  });
});

describe('POST /j/:token: the device cookie', () => {
  it('gives the same device the same card within ten minutes, and the device limit after', async () => {
    const l = await t.link({ askEmail: false });
    const jar: Jar = new Map();
    const first1 = await cardOf(await t.post(l, { name: 'Sam' }, { jar }));
    const before = await passCount();
    const askedBefore = turnstile.asked.length;
    // Double tap: the same card, no Turnstile, no new pass.
    const again = await t.post(l, { name: 'Sam' }, { jar });
    expect(again.status).toBe(303);
    expect(again.headers.get('location')).toBe(`/p/${first1.token}`);
    expect(await passCount()).toBe(before);
    expect(turnstile.asked.length).toBe(askedBefore);
    // Other fields from the same device: the device limit, no card.
    const other = await t.post(l, { name: 'Robin' }, { jar });
    expect(other.status).toBe(429);
    expect(await other.text()).toContain('Ask staff.');
    // Past ten minutes even the same fields are the device limit; past 24 hours the device may join again.
    t.kit.clock.advance(11 * 60_000);
    expect((await t.post(l, { name: 'Sam' }, { jar })).status).toBe(429);
    expect(await passCount()).toBe(before);
    t.kit.clock.advance(24 * 60 * 60_000);
    expect((await t.post(l, { name: 'Sam' }, { jar })).status).toBe(303);
    expect(await passCount()).toBe(before + 1);
  });

  it('does not replay without the cookie, and ignores a cookie this server never made', async () => {
    const l = await t.link({ askEmail: false });
    await cardOf(await t.post(l, { name: 'Sam' }));
    const before = await passCount();
    // No cookie: a new card (another device), not the first one's.
    const bare = await t.post(l, { name: 'Sam' });
    expect(bare.status).toBe(303);
    expect(await passCount()).toBe(before + 1);
    const forged = await t.post(
      l,
      { name: 'Sam' },
      { headers: { cookie: '__Host-pb_join=short' } },
    );
    expect(forged.status).toBe(303);
    expect(await passCount()).toBe(before + 2);
  });

  it('keeps the device limit per link', async () => {
    const live = await t.link({ askEmail: false });
    const jar: Jar = new Map();
    await cardOf(await t.post(live, { name: 'Sam' }, { jar }));
    const test = await t.link({ mode: 'test', askEmail: false });
    expect((await t.post(test, { name: 'Sam' }, { jar })).status).toBe(303);
  });
});

describe('POST /j/:token: link states', () => {
  it('answers a rotated and an unknown token with the dead-link page (404), charged to the miss counter', async () => {
    const l = await t.link({ askEmail: false });
    const old = { ...l };
    // A rotation: a new token for the same row (the trigger raises the generation).
    const fresh = t.kit.ctx.ids.token(16);
    const issued = await issueToken(t.kit.env, 'join', l.id, t.kit.org.id, fresh);
    await run(db(), 'UPDATE join_links SET token = ? WHERE id = ?', [issued.mac, l.id]);
    expect(
      (
        await first<{ generation: number }>(
          db(),
          'SELECT generation FROM join_links WHERE id = ?',
          [l.id],
        )
      )?.generation,
    ).toBe(2);
    const before = await passCount();
    for (const res of [await t.post(old), await t.get(old)]) {
      expect(res.status).toBe(404);
      expect(await res.text()).toContain('This link does not work');
    }
    const unknown = await t.post({ ...l, token: 'A'.repeat(22) });
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toContain('This link does not work');
    expect((await t.post({ ...l, token: 'short' })).status).toBe(404);
    expect(await passCount()).toBe(before);
    // The 404s are counted against the network prefix.
    const misses = await first<{ count: number }>(
      db(),
      "SELECT count FROM counters WHERE key LIKE 'asset.miss:%' ORDER BY window_start DESC LIMIT 1",
    );
    expect(misses?.count).toBeGreaterThanOrEqual(4);
    // The new token works.
    expect((await t.post({ ...l, token: fresh })).status).toBe(303);
  });

  it('answers a switched-off link with the closed page, and a link turned off mid-flight as gone', async () => {
    const l = await t.link({ askEmail: false, enabled: false });
    const before = await passCount();
    for (const res of [await t.get(l), await t.post(l)]) {
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('Not taking new cards right now');
    }
    expect(await passCount()).toBe(before);
  });

  it('is closed when the platform switch is off, or the template is archived', async () => {
    const l = await t.link({ askEmail: false });
    const before = await passCount();
    await withSetting('join.enabled', 'false', async () => {
      expect(await (await t.post(l)).text()).toContain('Not taking new cards right now');
      expect(await (await t.get(l)).text()).toContain('Not taking new cards right now');
    });
    await run(db(), "UPDATE templates SET status = 'archived' WHERE id = ?", [t.kit.template.id]);
    try {
      expect(await (await t.get(l)).text()).toContain('Not taking new cards right now');
    } finally {
      await run(db(), "UPDATE templates SET status = 'active' WHERE id = ?", [t.kit.template.id]);
    }
    expect((await t.post(l)).status).toBe(303);
    expect(await passCount()).toBe(before + 1);
  });

  it('is closed when the platform breaker is spent, and logs it at error', async () => {
    const l = await t.link({ askEmail: false });
    const error = vi.spyOn(console, 'error');
    const before = await passCount();
    await withSetting('join.platformDailyCap', '2', async () => {
      expect((await t.post(l, {}, { jar: new Map() })).status).toBe(303);
      expect((await t.post(l, {}, { jar: new Map() })).status).toBe(303);
      const third = await t.post(l, {}, { jar: new Map() });
      expect(third.status).toBe(200);
      expect(await third.text()).toContain('Not taking new cards right now');
    });
    expect(await passCount()).toBe(before + 2);
    expect(JSON.stringify(error.mock.calls)).toContain('JOIN_PLATFORM_CAP');
    error.mockRestore();
  });

  it('answers 429 past the request rate limit and past the hourly count per network', async () => {
    const l = await t.link({ askEmail: false });
    const env = { ...t.kit.env, RL_JOIN: fakeLimiter(2) as unknown as RateLimit };
    const before = await passCount();
    const a = await t.post(l, {}, { env, ip: '192.0.2.50' });
    const b = await t.post(l, {}, { env, ip: '192.0.2.51' });
    expect([a.status, b.status]).toEqual([303, 303]);
    const limited = await t.post(l, {}, { env, ip: '192.0.2.52' });
    expect(limited.status).toBe(429);
    expect(await limited.text()).toContain('Too many tries');
    expect(await passCount()).toBe(before + 2);
    // 60 an hour from one network on one link.
    const counterKey = (
      await all<{ key: string }>(db(), 'SELECT key FROM counters WHERE key LIKE ?', [
        `join:ip:${l.id}:%`,
      ])
    )[0]?.key;
    expect(counterKey).toBeDefined();
    await run(db(), 'UPDATE counters SET count = 60 WHERE key = ?', [counterKey ?? '']);
    const over = await t.post(l, {}, { ip: '192.0.2.50' });
    expect(over.status).toBe(429);
    expect(await passCount()).toBe(before + 2);
  });
});

describe('POST /j/:token: a card with an email', () => {
  it('mails the new card (within the address budget), with the join line', async () => {
    const l = await t.link();
    const addr = email();
    const res = await t.post(l, { email: addr });
    const { passId } = await cardOf(res);
    const pass = await getPass(db(), passId);
    expect(pass?.holderEmail).toBe(addr);
    // The issuance mail is sent by the minute sweep, as a non-tenant issuance defers in a request.
    t.kit.queue.sent.length = 0;
    await sweepDelivery(jobCtxOf(t.kit));
    const outboxId = await outboxOf(passId);
    expect((t.kit.queue.sent as { outboxId?: string }[]).some((m) => m.outboxId === outboxId)).toBe(
      true,
    );
    const before = t.kit.mailer.sent.length;
    await handleEmailSend({ kind: 'email.send', outboxId }, jobCtxOf(t.kit));
    expect(t.kit.mailer.sent).toHaveLength(before + 1);
    const mail = t.kit.mailer.sent.at(-1);
    expect(mail?.to).toBe(addr);
    expect(mail?.text).toContain("You asked for this card at Test Gym. Didn't? Ignore this email.");
    // An operator's pass mail has no such line.
    const operated = await t.kit.pass({ holderEmail: email() });
    await sweepDelivery(jobCtxOf(t.kit));
    expect(operated.id).not.toBe(passId);
  });

  it('creates no card for an address that has one, queues one mail, and answers the same page', async () => {
    const l = await t.link();
    const addr = email();
    const existing = await t.kit.pass({ holderEmail: addr });
    const before = await passCount();
    const res = await t.post(l, { email: addr });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Check your email');
    expect(html).toContain(addr);
    expect(html).not.toContain('/p/');
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(await passCount()).toBe(before);
    expect(await issues(l.id)).toEqual([]);
    expect(resends().filter((m) => m.passId === existing.id)).toHaveLength(1);
    // The job mails the existing card to the address it holds.
    t.kit.queue.sent.length = 0;
    await handleJoinResend(
      { kind: 'join.resend', passId: existing.id, linkId: l.id },
      jobCtxOf(t.kit),
    );
    await sweepDelivery(jobCtxOf(t.kit));
    const outbox = await all<{ id: string; pass_id: string }>(
      db(),
      "SELECT id, pass_id FROM outbox WHERE pass_id = ? AND kind = 'email'",
      [existing.id],
    );
    expect(outbox.length).toBeGreaterThan(0);
  });

  it('is the same page over the mail budget, with no job queued', async () => {
    const l = await t.link();
    const addr = email();
    await t.kit.pass({ holderEmail: addr });
    t.kit.queue.sent.length = 0;
    const pages: string[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await t.post(l, { email: addr }, { jar: new Map() });
      expect(res.status).toBe(200);
      pages.push(await res.text());
    }
    // Three a day, then none; the browser cannot tell.
    expect(resends()).toHaveLength(3);
    expect(new Set(pages.map((p) => p.replace(/nonce="[^"]*"/g, ''))).size).toBe(1);
    t.kit.clock.advance(24 * 60 * 60_000);
    await t.post(l, { email: addr }, { jar: new Map() });
    expect(resends()).toHaveLength(4);
  });

  it('does not match a removed card or another mode: a new card is made', async () => {
    const l = await t.link();
    const addr = email();
    const removed = await t.kit.pass({ holderEmail: addr });
    await run(db(), 'UPDATE passes SET removed_at = 1 WHERE id = ?', [removed.id]);
    expect(
      (
        await first<{ removed_at: number }>(db(), 'SELECT removed_at FROM passes WHERE id = ?', [
          removed.id,
        ])
      )?.removed_at,
    ).toBe(1);
    const res = await t.post(l, { email: addr }, { jar: new Map() });
    expect(res.status).toBe(200);
    expect(resends().filter((m) => m.passId === removed.id)).toHaveLength(0);
    const test = await t.link({ mode: 'test' });
    const live = email();
    await t.kit.pass({ holderEmail: live });
    // A live card does not stand in for the test link's: the test link makes its own.
    expect((await t.post(test, { email: live }, { jar: new Map() })).status).toBe(200);
    const row = await first<{ mode: string }>(
      db(),
      'SELECT mode FROM passes WHERE id = (SELECT pass_id FROM join_issues WHERE link_id = ?)',
      [test.id],
    );
    expect(row?.mode).toBe('test');
  });

  it('answers a known and a new address with the same status, page, headers and cookies', async () => {
    const l = await t.link();
    const known = email();
    await t.kit.pass({ holderEmail: known });
    const fresh = email();
    const a = await t.post(l, { email: known }, { jar: new Map() });
    const b = await t.post(l, { email: fresh }, { jar: new Map() });
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(b.headers.get('location')).toBeNull();
    expect(b.headers.getSetCookie()).toEqual(a.headers.getSetCookie());
    const strip = async (r: Response, addr: string) =>
      (await r.text()).replaceAll(addr, 'ADDR').replace(/nonce="[^"]*"/g, '');
    expect(await strip(b, fresh)).toBe(await strip(a, known));
    expect(
      (await t.kit.env.DB.prepare('SELECT 1 FROM passes WHERE holder_email = ?')
        .bind(fresh)
        .first()) !== null,
    ).toBe(true);
  });

  it('two submits of one new address make one card and one re-sent mail', async () => {
    const l = await t.link();
    const addr = email();
    t.kit.queue.sent.length = 0;
    const [a, b] = await Promise.all([
      t.post(l, { email: addr }, { jar: new Map(), ip: '203.0.113.20' }),
      t.post(l, { email: addr }, { jar: new Map(), ip: '203.0.113.21' }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await issues(l.id)).toHaveLength(1);
    expect(resends()).toHaveLength(1);
  });
});

describe('POST /j/:token: caps and test links', () => {
  it('answers No more cards today at the link limit, before building a card', async () => {
    const l = await t.link({ askEmail: false, dailyLimit: 2 });
    const before = await passCount();
    expect((await t.post(l, {}, { jar: new Map() })).status).toBe(303);
    expect((await t.post(l, {}, { jar: new Map() })).status).toBe(303);
    const over = await t.post(l, {}, { jar: new Map() });
    expect(over.status).toBe(429);
    expect(await over.text()).toContain('No more cards today');
    expect(await passCount()).toBe(before + 2);
    // Rolling 24 hours: it opens again.
    t.kit.clock.advance(24 * 60 * 60_000 + 1);
    expect((await t.post(l, {}, { jar: new Map() })).status).toBe(303);
  });

  it('builds no card at the cap: no object is stored for the refused attempt', async () => {
    const l = await t.link({ askEmail: false, dailyLimit: 1 });
    await t.post(l, {}, { jar: new Map() });
    const put = vi.spyOn(t.kit.env.BUCKET, 'put');
    expect((await t.post(l, {}, { jar: new Map() })).status).toBe(429);
    expect(put).not.toHaveBeenCalled();
    put.mockRestore();
  });

  it('holds the org cap across links', async () => {
    const l = await t.link({ askEmail: false });
    await withSetting('join.orgDailyCap', '1', async () => {
      expect((await t.post(l, {}, { jar: new Map() })).status).toBe(303);
      const res = await t.post(l, {}, { jar: new Map() });
      expect(res.status).toBe(429);
      expect(await res.text()).toContain('No more cards today');
    });
  });

  it('a test link makes a test pass; its mail is captured and nothing is sent', async () => {
    const l = await t.link({ mode: 'test' });
    const addr = email();
    const res = await t.post(l, { email: addr });
    const { passId } = await cardOf(res);
    const pass = await getPass(db(), passId);
    expect(pass).toMatchObject({ mode: 'test', ownerUserId: null });
    t.kit.queue.sent.length = 0;
    await sweepDelivery(jobCtxOf(t.kit));
    const outboxId = await outboxOf(passId);
    const sent = t.kit.mailer.sent.length;
    await handleEmailSend({ kind: 'email.send', outboxId }, jobCtxOf(t.kit));
    expect(t.kit.mailer.sent).toHaveLength(sent);
    const captured = await all<{ to_email: string }>(
      db(),
      'SELECT * FROM captured_emails WHERE pass_id = ?',
      [passId],
    );
    expect(captured).toHaveLength(1);
  });

  it('never falls back to the live release for a test link', async () => {
    const id = `tpl-live-only-${n++}`;
    const base = joinTemplate(id).resolved;
    const resolved = t.kit.registry.add({
      id,
      orgId: null,
      version: 'v1',
      manifest: base.manifest,
      passJson: base.passJson,
      assets: { 'icon.png': TINY_PNG },
    });
    await persistTemplate(t.kit.fx, resolved, { registry: t.kit.registry });
    await approveAppleRelease(t.kit, { templateId: id, version: 'v1', mode: 'live' });
    const l = await makeJoinLink(t.kit.fx, { orgId: t.kit.org.id, templateId: id, mode: 'test' });
    const before = await passCount();
    const get = await t.get(l);
    expect(await get.text()).toContain('Not taking new cards right now');
    const res = await t.post(l, { name: null, email: null });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Not taking new cards right now');
    expect(await passCount()).toBe(before);
    // The live link of the same template opens.
    const live = await makeJoinLink(t.kit.fx, { orgId: t.kit.org.id, templateId: id });
    expect((await t.post(live, { name: null })).status).toBe(303);
  });
});

describe('review fixes', () => {
  const counter = async () =>
    (
      await first<{ n: number | null }>(
        db(),
        "SELECT SUM(count) AS n FROM counters WHERE key = 'join:platform'",
      )
    )?.n ?? 0;

  it('the platform breaker counts cards, not duplicates or refusals', async () => {
    const l = await t.link();
    const addr = email();
    await t.kit.pass({ holderEmail: addr });
    for (let i = 0; i < 5; i++) await t.post(l, { email: addr }, { jar: new Map() });
    turnstile.verdict = verdictOf({ success: false });
    await t.post(l, { email: email() }, { jar: new Map() });
    turnstile.verdict = verdictOf();
    expect(await t.post(l, { name: 'x'.repeat(41) })).toHaveProperty('status', 422);
    expect(await counter()).toBe(0);
    expect((await t.post(l, { email: email() }, { jar: new Map() })).status).toBe(200);
    expect(await counter()).toBe(1);
  });

  it('the mail budget is one per mailbox: +tag and Gmail dot variants share it, and it rolls', async () => {
    const l = await t.link();
    const variants = ['ali.ce+a@gmail.com', 'alice+b@gmail.com', 'a.l.i.c.e@googlemail.com'];
    const base = `mb${n++}`;
    const make = (v: string) =>
      v
        .replace('ali.ce', `${base}.x`)
        .replace('alice', `${base}x`)
        .replace('a.l.i.c.e', `${base}.x`);
    const passes: string[] = [];
    for (const v of variants) {
      // Spend three slots with other mailboxes first is not needed: three variants of one mailbox spend one key.
      const res = await t.post(l, { email: make(v) }, { jar: new Map() });
      passes.push((await cardOf(res)).passId);
    }
    const fourth = await t.post(l, { email: make('alice+d@gmail.com') }, { jar: new Map() });
    const fourthPass = (await cardOf(fourth)).passId;
    await sweepDelivery(jobCtxOf(t.kit));
    // A card is made and shown; no mail is queued for it.
    expect(await outboxOf(fourthPass)).toBe('');
    for (const id of passes) expect(await outboxOf(id)).not.toBe('');
    // The stored address is the one typed, not the canonical form.
    expect((await getPass(db(), fourthPass))?.holderEmail).toBe(make('alice+d@gmail.com'));
    t.kit.clock.advance(24 * 60 * 60_000 + 1);
    const later = await cardOf(
      await t.post(l, { email: make('alice+e@gmail.com') }, { jar: new Map() }),
    );
    await sweepDelivery(jobCtxOf(t.kit));
    expect(await outboxOf(later.passId)).not.toBe('');
  });

  it('an operator card re-sent by a join link carries the join line', async () => {
    const l = await t.link();
    const addr = email();
    const operated = await t.kit.pass({ holderEmail: addr });
    await t.post(l, { email: addr }, { jar: new Map() });
    await handleJoinResend(
      { kind: 'join.resend', passId: operated.id, linkId: l.id },
      jobCtxOf(t.kit),
    );
    const ids = await all<{ id: string }>(
      db(),
      "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'email' ORDER BY rowid DESC",
      [operated.id],
    );
    await handleEmailSend({ kind: 'email.send', outboxId: ids[0]?.id ?? '' }, jobCtxOf(t.kit));
    expect(t.kit.mailer.sent.at(-1)?.text).toContain('You asked for this card at');
  });

  it('refuses a slash or a domain-shaped name and keeps St. John and J.R.', async () => {
    const l = await t.link({ askEmail: false });
    for (const name of ['paypal-verify.com', 'bit.ly/x9', 'scam．co/x', 'a\\b'])
      expect((await t.post(l, { name }, { jar: new Map() })).status, name).toBe(422);
    for (const name of ['St. John', 'J.R.', 'Anne-Marie'])
      expect((await t.post(l, { name }, { jar: new Map() })).status, name).toBe(303);
  });

  it('refuses a Turnstile token past 2048 characters before asking Cloudflare', async () => {
    const l = await t.link({ askEmail: false });
    const res = await t.post(l, { 'cf-turnstile-response': 'x'.repeat(2049) });
    expect(res.status).toBe(403);
    expect(turnstile.asked).toEqual([]);
  });

  it('never replays a card that was voided, and decides the name field from the release', async () => {
    const l = await t.link({ askEmail: false });
    const jar: Jar = new Map();
    const made = await cardOf(await t.post(l, { name: 'Sam' }, { jar }));
    await run(db(), "UPDATE passes SET status = 'voided' WHERE id = ?", [made.passId]);
    expect((await t.post(l, { name: 'Sam' }, { jar })).status).toBe(429);
    // A stored name input the release no longer offers: the page and the post both ask nothing.
    await run(db(), "UPDATE join_links SET name_input = 'ghost' WHERE id = ?", [l.id]);
    expect(await (await t.get(l)).text()).not.toContain('First name');
    expect((await t.post(l, { name: null }, { jar: new Map() })).status).toBe(303);
    expect((await t.post(l, { name: 'Sam' }, { jar: new Map() })).status).toBe(422);
  });

  it('a link turned off between the lookup and the create answers closed; a rotated one, expired', async () => {
    const l = await t.link({ askEmail: false });
    const d = db();
    const batch = d.batch.bind(d);
    d.batch = (async (statements: D1PreparedStatement[]) => {
      d.batch = batch;
      await run(d, 'UPDATE join_links SET enabled = 0 WHERE id = ?', [l.id]);
      return batch(statements);
    }) as typeof d.batch;
    try {
      const res = await t.post(l, {}, { jar: new Map() });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('Not taking new cards right now');
    } finally {
      d.batch = batch;
    }
  });
});
