import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fakeAuth, makeOrg } from '../../../../test/helpers/index.ts';
import { PassEventListSchema } from '../../../shared/contracts/index.ts';
import { createApp } from '../../app.ts';
import { all, first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { type Kit, setupKit } from '../passes/test-kit.ts';
import { dailyEvents } from './jobs.ts';
import { hashDevice, recordPassEvent, recordPassEvents, sanitizeEventData } from './record.ts';

const ORIGIN = 'https://wallet.test';
const fake = fakeAuth(ORIGIN);
let kit: Kit;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  kit = await setupKit();
  app = createApp({ stores: fake.stores });
});

type Headers = Record<string, string>;
const events = (passId: string, headers: Headers, query = '') =>
  app.request(`${ORIGIN}/api/v1/passes/${passId}/events${query}`, { headers }, kit.env);
const rows = (passId: string) =>
  all<{
    kind: string;
    mode: string;
    device: string | null;
    data: string;
    actor_type: string | null;
  }>(
    kit.env.DB,
    'SELECT kind, mode, device, data, actor_type FROM pass_events WHERE pass_id = ? ORDER BY at, id',
    [passId],
  );
const base = (passId: string) => ({ orgId: kit.org.id, passId, mode: 'live' as const });

describe('recordPassEvent', () => {
  it('stores the event with the actor and a hashed device', async () => {
    const pass = await kit.pass();
    await recordPassEvent(kit.ctx, {
      ...base(pass.id),
      kind: 'device.registered',
      device: 'abc123-device',
      actor: { type: 'device', id: null },
      data: { count: 2 },
    });
    const stored = (await rows(pass.id)).find((r) => r.kind === 'device.registered');
    expect(stored).toMatchObject({ mode: 'live', actor_type: 'device' });
    expect(stored?.device).toBe((await sha256Hex('abc123-device')).slice(0, 12));
    expect(stored?.device).toBe(await hashDevice('abc123-device'));
    expect(JSON.parse(stored?.data ?? '')).toEqual({ count: 2 });
    expect(JSON.stringify(stored)).not.toContain('abc123-device');
  });

  it('drops emails, tokens and personalization from data', () => {
    expect(
      sanitizeEventData({
        version: 3,
        holderEmail: 'a@b.test',
        pushToken: 'x',
        note: 'sent to a@b.test',
        reason: 'BadDeviceToken',
        personalization: { memberName: 'Alex' },
        nested: { authToken: 't', ok: true },
      }),
    ).toEqual({ version: 3, reason: 'BadDeviceToken', nested: { ok: true } });
    expect(
      sanitizeEventData(
        Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${i}`, 'x'.repeat(300)])),
      ),
    ).toEqual({
      truncated: true,
    });
  });

  it('never throws: a failed write is logged with a stable code', async () => {
    const warn = vi.spyOn(kit.ctx.log, 'error');
    await expect(
      recordPassEvent(kit.ctx, { ...base('no-such-pass'), kind: 'page.opened' }),
    ).resolves.toBeUndefined();
    await expect(
      recordPassEvent(kit.ctx, { ...base('x'), kind: 'nope' as never }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      'events.record_failed',
      expect.objectContaining({ code: 'EVENT_RECORD_FAILED' }),
    );
    warn.mockRestore();
  });

  it('records a batch in order', async () => {
    const pass = await kit.pass();
    await recordPassEvents(kit.ctx, [
      { ...base(pass.id), kind: 'push.queued' },
      { ...base(pass.id), kind: 'push.sent', device: 'd1' },
      { ...base(pass.id), kind: 'push.failed', device: 'd2', data: { status: 410 } },
    ]);
    expect((await rows(pass.id)).map((r) => r.kind)).toEqual([
      'pass.issued',
      'push.queued',
      'push.sent',
      'push.failed',
    ]);
  });
});

describe('GET /passes/{id}/events', () => {
  it('pages newest first and filters by kind', async () => {
    const pass = await kit.pass();
    for (let i = 0; i < 5; i++) {
      kit.clock.advance(1000);
      await recordPassEvent(kit.ctx, { ...base(pass.id), kind: 'page.opened', data: { i } });
    }
    const first = PassEventListSchema.parse(
      await (await events(pass.id, fake.admin(), '?limit=4')).json(),
    );
    expect(first.items).toHaveLength(4);
    expect(first.items.map((e) => e.data.i)).toEqual([4, 3, 2, 1]);
    expect(first.nextCursor).not.toBeNull();
    const second = PassEventListSchema.parse(
      await (await events(pass.id, fake.admin(), `?limit=4&cursor=${first.nextCursor}`)).json(),
    );
    expect(second.items.map((e) => e.kind)).toEqual(['page.opened', 'pass.issued']);
    expect(second.nextCursor).toBeNull();
    const only = PassEventListSchema.parse(
      await (await events(pass.id, fake.admin(), '?kind=pass.issued')).json(),
    );
    expect(only.items.map((e) => e.kind)).toEqual(['pass.issued']);
    expect((await events(pass.id, fake.admin(), '?kind=bogus')).status).toBe(422);
    const bad = await events(pass.id, fake.admin(), '?cursor=garbage');
    expect(bad.status).toBe(422);
    expect(await bad.json()).toMatchObject({ code: 'INVALID_CURSOR' });
  });

  it('needs passes:read and stays inside the key org', async () => {
    const pass = await kit.pass();
    const other = await makeOrg(kit.fx, { name: 'Other' });
    expect((await events(pass.id, {})).status).toBe(401);
    expect((await events(pass.id, fake.user())).status).toBe(403);
    expect((await events(pass.id, fake.apiKey({ scopes: ['templates:read'] }))).status).toBe(403);
    expect((await events(pass.id, fake.apiKey({ orgId: kit.org.id }))).status).toBe(200);
    expect((await events(pass.id, fake.apiKey({ orgId: other.id }))).status).toBe(404);
    expect((await events('missing', fake.admin())).status).toBe(404);
  });

  it('returns each event with its mode, in either caller mode', async () => {
    const pass = await kit.pass();
    await recordPassEvent(kit.ctx, { ...base(pass.id), mode: 'test', kind: 'email.captured' });
    for (const headers of [
      fake.admin(),
      fake.admin({ mode: 'test' }),
      fake.apiKey({ mode: 'test' }),
    ]) {
      const page = PassEventListSchema.parse(await (await events(pass.id, headers)).json());
      expect(page.items.map((e) => e.mode)).toEqual(['test', 'live']);
    }
  });
});

describe('publish records pass.issued and pass.updated', () => {
  it('writes version, cause, source and notified', async () => {
    const { publishPass } = await import('../passes/publish.ts');
    const pass = await kit.pass();
    kit.clock.advance(1000);
    await publishPass(kit.ctx, {
      passId: pass.id,
      cause: 'admin',
      source: 'broadcast',
      actor: { type: 'user', id: 'u1' },
      mutate: () => ({ personalization: { memberName: 'Changed' } }),
    });
    const list = await rows(pass.id);
    expect(list.map((r) => r.kind)).toEqual(['pass.issued', 'pass.updated']);
    expect(JSON.parse(list[0]?.data ?? '')).toEqual({
      version: 1,
      cause: 'create',
      source: null,
      notified: false,
    });
    expect(JSON.parse(list[1]?.data ?? '')).toEqual({
      version: 2,
      cause: 'admin',
      source: 'broadcast',
      notified: false,
    });
    const version = await first<{ source: string | null; cause: string }>(
      kit.env.DB,
      'SELECT source, cause FROM pass_versions WHERE pass_id = ? AND version = 2',
      [pass.id],
    );
    expect(version).toEqual({ source: 'broadcast', cause: 'admin' });
    // The trigger consumes the pending source: a later publish without one has none.
    await publishPass(kit.ctx, {
      passId: pass.id,
      cause: 'admin',
      actor: { type: 'user', id: 'u1' },
      mutate: () => ({ personalization: { memberName: 'Again' } }),
    });
    expect(
      (
        await first<{ source: string | null }>(
          kit.env.DB,
          'SELECT source FROM pass_versions WHERE pass_id = ? AND version = 3',
          [pass.id],
        )
      )?.source,
    ).toBeNull();
  });

  it('marks an update notified when a changed field carries a changeMessage', async () => {
    const { publishPass } = await import('../passes/publish.ts');
    const pass = await kit.pass();
    kit.clock.advance(1000);
    await publishPass(kit.ctx, {
      passId: pass.id,
      cause: 'admin',
      notify: true,
      actor: { type: 'user', id: 'u1' },
      mutate: () => ({ personalization: { memberName: 'Notified' } }),
    });
    const updated = (await rows(pass.id)).find((r) => r.kind === 'pass.updated');
    expect(JSON.parse(updated?.data ?? '')).toMatchObject({ notified: true });
  });
});

describe('retention', () => {
  it('deletes events older than retention.eventsDays', async () => {
    const pass = await kit.pass();
    const now = kit.clock.now();
    await recordPassEvent(kit.ctx, {
      ...base(pass.id),
      kind: 'page.opened',
      at: now - 91 * 86_400_000,
    });
    await recordPassEvent(kit.ctx, {
      ...base(pass.id),
      kind: 'page.opened',
      at: now - 89 * 86_400_000,
    });
    await dailyEvents(kit.ctx);
    const left = await all<{ at: number }>(
      kit.env.DB,
      "SELECT at FROM pass_events WHERE pass_id = ? AND kind = 'page.opened'",
      [pass.id],
    );
    expect(left).toHaveLength(1);
    expect(left[0]?.at).toBe(now - 89 * 86_400_000);
  });
});

describe('events follow the pass', () => {
  it('cascades when the pass is hard-deleted', async () => {
    const pass = await kit.pass();
    await run(kit.env.DB, 'DELETE FROM passes WHERE id = ?', [pass.id]);
    expect(await rows(pass.id)).toEqual([]);
  });
});
