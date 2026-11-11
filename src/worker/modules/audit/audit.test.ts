import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fakeAuth, fixtures, makeEnv, makeOrg, makeUser } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { ManualClock } from '../../platform/clock.ts';
import { all, first, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { dailyAudit } from './jobs.ts';
import { diffFields, redact, redactDetail, redactForRead, safeLabel } from './redact.ts';
import { recordAudit } from './service.ts';

const fake = fakeAuth();
let appEnv: AppEnv;
const app = createApp({ stores: fake.stores });
const get = (query: string, headers = fake.admin()) =>
  app.request(`/api/v1/audit/platform${query}`, { headers }, appEnv);

type Page = {
  items: { id: number; action: string; orgId: string | null; detail: unknown }[];
  nextCursor: string | null;
};

beforeAll(async () => {
  appEnv = await makeEnv();
});

beforeEach(async () => {
  await run(env.DB, 'DELETE FROM audit_log');
  await run(env.DB, 'DELETE FROM settings');
});

describe('redaction', () => {
  it('masks sensitive keys at any depth and cuts long strings', () => {
    const out = redact({
      name: 'x',
      apiKey: 'wlt_abc',
      nested: { password: 'p', ok: 1, list: [{ token: 't' }] },
      long: 'a'.repeat(900),
      personalization: { email: 'a@b.c' },
    }) as Record<string, any>;
    expect(out.apiKey).toBe('[redacted]');
    expect(out.nested.password).toBe('[redacted]');
    expect(out.nested.list[0].token).toBe('[redacted]');
    expect(out.personalization).toBe('[redacted]');
    expect(out.nested.ok).toBe(1);
    expect(out.long).toHaveLength(503);
  });

  it('masks supported email punctuation in labels and legacy detail', () => {
    for (const char of "!#$%&'*+/=?^_`{|}~-") {
      const email = `private${char}@example.test`;
      expect(safeLabel(`Operator <${email}>`)).toBeNull();
      expect(redactForRead({ note: `Contact ${email}` }, false)).toMatchObject({
        note: '[redacted]',
      });
    }
  });

  it('replaces oversized detail and diffs only changed fields', () => {
    const big = Object.fromEntries(
      Array.from({ length: 200 }, (_, i) => [`k${i}`, 'v'.repeat(100)]),
    );
    expect(redactDetail(big)).toEqual({ truncated: true });
    expect(diffFields({ a: 1, b: 2, secret: 'x' }, { a: 1, b: 3, secret: 'y' })).toEqual({
      b: { from: 2, to: 3 },
      secret: '[redacted]',
    });
  });

  it('recordAudit redacts detail before storing', async () => {
    const ctx = createServiceContext(appEnv);
    await recordAudit(ctx, {
      actorType: 'system',
      action: 'test.redact',
      detail: { token: 'abc', label: 'ok' },
    });
    const row = await first<{ detail: string }>(
      env.DB,
      "SELECT detail FROM audit_log WHERE action = 'test.redact'",
    );
    expect(JSON.parse(row?.detail ?? '{}')).toEqual({ token: '[redacted]', label: 'ok' });
  });
});

describe('audit api', () => {
  it('filters by org, actor, action prefix, target and time; pages newest first', async () => {
    const f = fixtures(appEnv);
    const a = await makeOrg(f);
    const b = await makeOrg(f);
    const clock = new ManualClock(1_000_000);
    const ctx = createServiceContext(appEnv, { clock });
    const entries = [
      {
        orgId: a.id,
        actorId: 'u1',
        action: 'identity.upload',
        targetType: 'identity',
        targetId: 'i1',
      },
      {
        orgId: a.id,
        actorId: 'u2',
        action: 'identity.delete',
        targetType: 'identity',
        targetId: 'i1',
      },
      { orgId: b.id, actorId: 'u1', action: 'org.update', targetType: 'org', targetId: b.id },
      {
        orgId: null,
        actorId: 'u1',
        action: 'settings.update',
        targetType: 'settings',
        targetId: 'platform',
      },
    ];
    for (const e of entries) {
      clock.advance(1000);
      await recordAudit(ctx, { actorType: 'user', ...e });
    }

    const list = async (q: string) => (await (await get(q)).json()) as Page;
    expect((await list(`?orgId=${a.id}`)).items.map((i) => i.action)).toEqual([
      'identity.delete',
      'identity.upload',
    ]);
    expect((await list(`?orgId=${b.id}`)).items.map((i) => i.action)).toEqual(['org.update']);
    expect((await list('?action=identity.')).items).toHaveLength(2);
    expect((await list('?action=identity.up')).items.map((i) => i.action)).toEqual([
      'identity.upload',
    ]);
    expect((await list('?action=%25')).items).toHaveLength(0);
    expect(
      (await list(`?orgId=${a.id}&excludeAction=identity.d`)).items.map((i) => i.action),
    ).toEqual(['identity.upload']);
    expect((await list('?actorId=u2')).items).toHaveLength(1);
    expect((await list('?targetType=identity&targetId=i1')).items).toHaveLength(2);
    expect((await list('?from=1002000&to=1003000')).items.map((i) => i.action)).toEqual([
      'org.update',
      'identity.delete',
    ]);

    const page1 = await list(`?limit=2&targetType=identity`);
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBeNull();
    const first2 = await list('?limit=3');
    expect(first2.nextCursor).toBeTruthy();
    const next = await list(`?limit=3&cursor=${first2.nextCursor}`);
    expect(next.items.every((i) => i.id < (first2.items.at(-1)?.id ?? 0))).toBe(true);
  });

  it('rejects a malformed cursor and non-admins', async () => {
    expect((await get('?cursor=abc')).status).toBe(422);
    expect((await get('', fake.user())).status).toBe(403);
    expect((await get('', {})).status).toBe(401);
  });
});

describe('audit labels', () => {
  it('names actors and targets, null when gone or unknown', async () => {
    const f = fixtures(appEnv, new ManualClock(Date.now()));
    const org = await makeOrg(f, { name: 'Acme Gym' });
    const user = await makeUser(f);
    await run(env.DB, 'UPDATE users SET name = ? WHERE id = ?', ['Fatima Zahra', user.id]);
    const ctx = createServiceContext(appEnv);
    await recordAudit(ctx, {
      orgId: org.id,
      actorType: 'user',
      actorId: user.id,
      action: 'org.update',
      targetType: 'org',
      targetId: org.id,
    });
    await recordAudit(ctx, {
      actorType: 'user',
      actorId: 'deleted-user',
      action: 'pass.void',
      targetType: 'pass',
      targetId: 'gone',
    });
    await recordAudit(ctx, { actorType: 'system', action: 'cron.run' });
    const page = (await (await get('')).json()) as {
      items: { action: string; actorLabel: string | null; targetLabel: string | null }[];
    };
    const by = (a: string) => page.items.find((i) => i.action === a);
    expect(by('org.update')).toMatchObject({ actorLabel: 'Fatima Zahra', targetLabel: 'Acme Gym' });
    expect(by('pass.void')).toMatchObject({ actorLabel: null, targetLabel: null });
    expect(by('cron.run')).toMatchObject({ actorLabel: null, targetLabel: null });
  });
});

describe('audit retention', () => {
  it('deletes rows older than retention.auditDays and records the cron run', async () => {
    const day = 86_400_000;
    const now = 1000 * day;
    for (const age of [400, 366, 364, 1]) {
      await run(
        env.DB,
        "INSERT INTO audit_log (at, actor_type, action) VALUES (?, 'system', 'old.row')",
        [now - age * day],
      );
    }
    const ctx = createServiceContext(appEnv, { clock: new ManualClock(now) });
    await dailyAudit(ctx);
    const left = await all<{ at: number }>(
      env.DB,
      "SELECT at FROM audit_log WHERE action = 'old.row' ORDER BY at",
    );
    expect(left.map((r) => (now - r.at) / day)).toEqual([364, 1]);
    const cron = await first<{ value: string }>(
      env.DB,
      "SELECT value FROM settings WHERE scope = 'system' AND key = 'cron.daily'",
    );
    expect(JSON.parse(cron?.value ?? '{}')).toEqual({ at: now });
  });
});
