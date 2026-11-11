import { beforeAll, describe, expect, it, vi } from 'vitest';
import { makeApiKey, makeOrg, makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { PassEventListSchema } from '../../../shared/contracts/index.ts';
import { createApp } from '../../app.ts';
import { all, first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import { dailyEvents } from './jobs.ts';
import { hashDevice, recordPassEvent, recordPassEvents, sanitizeEventData } from './record.ts';
import { type EventAuth, eventAuth, eventMember, eventStores } from './test-auth-fixtures.ts';

const ORIGIN = 'https://wallet.test';
let credentials: EventAuth;
let kit: Kit;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  kit = await setupKit();
  credentials = await eventAuth(kit);
  app = createApp({ stores: eventStores(kit), clock: kit.clock });
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
      await (await events(pass.id, credentials.member.session.headers, '?limit=4')).json(),
    );
    expect(first.items).toHaveLength(4);
    expect(first.items.map((e) => e.data.i)).toEqual([4, 3, 2, 1]);
    expect(first.nextCursor).not.toBeNull();
    const second = PassEventListSchema.parse(
      await (
        await events(
          pass.id,
          credentials.member.session.headers,
          `?limit=4&cursor=${first.nextCursor}`,
        )
      ).json(),
    );
    expect(second.items.map((e) => e.kind)).toEqual(['page.opened', 'pass.issued']);
    expect(second.nextCursor).toBeNull();
    const only = PassEventListSchema.parse(
      await (await events(pass.id, credentials.member.session.headers, '?kind=pass.issued')).json(),
    );
    expect(only.items.map((e) => e.kind)).toEqual(['pass.issued']);
    expect((await events(pass.id, credentials.member.session.headers, '?kind=bogus')).status).toBe(
      422,
    );
    const bad = await events(pass.id, credentials.member.session.headers, '?cursor=garbage');
    expect(bad.status).toBe(422);
    expect(await bad.json()).toMatchObject({ code: 'INVALID_CURSOR' });
  });

  it('needs passes:read and stays inside the key org', async () => {
    const pass = await kit.pass();
    const other = await makeOrg(kit.fx, { name: 'Other' });
    const outsider = await makeUser(kit.fx);
    const session = await makeSession(kit.fx, { userId: outsider.id });
    const noScope = await makeApiKey(kit.fx, { scopes: ['templates:read'] });
    const foreignKey = await makeApiKey(kit.fx, { orgId: other.id });
    expect((await events(pass.id, {})).status).toBe(401);
    expect((await events(pass.id, session.headers)).status).toBe(404);
    expect((await events(pass.id, noScope.headers)).status).toBe(403);
    expect((await events(pass.id, credentials.key.headers)).status).toBe(200);
    expect((await events(pass.id, foreignKey.headers)).status).toBe(404);
    expect((await events('missing', credentials.member.session.headers)).status).toBe(404);
  });

  it('requires current membership and read capability for events and devices', async () => {
    const pass = await kit.pass();
    const foreignOrg = await makeOrg(kit.fx);
    const foreign = await eventMember(kit, foreignOrg.id);
    const noRead = await eventMember(kit, kit.org.id, ['template_author']);
    const outsider = await makeUser(kit.fx);
    const platformAdmin = await makeSession(kit.fx, {
      userId: outsider.id,
      roles: ['admin', 'user'],
    });
    const member = await eventMember(kit, kit.org.id);
    const ordinarySession = await makeSession(kit.fx, { userId: member.user.id });
    const key = await makeApiKey(kit.fx, { orgId: kit.org.id });
    const noScope = await makeApiKey(kit.fx, { orgId: kit.org.id, scopes: ['templates:read'] });
    const wrongMode = await makeApiKey(kit.fx, { orgId: kit.org.id, mode: 'test' });
    for (const resource of ['events', 'devices']) {
      const request = (headers: Headers) =>
        app.request(`${ORIGIN}/api/v1/passes/${pass.id}/${resource}`, { headers }, kit.env);
      expect((await request(member.session.headers)).status).toBe(200);
      expect((await request(ordinarySession.headers)).status).toBe(200);
      expect((await request(platformAdmin.headers)).status).toBe(404);
      expect((await request(foreign.session.headers)).status).toBe(404);
      expect((await request(noRead.session.headers)).status).toBe(404);
      expect((await request(key.headers)).status).toBe(200);
      expect((await request(noScope.headers)).status).toBe(403);
      expect((await request(wrongMode.headers)).status).toBe(404);
    }
    await run(kit.env.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
      kit.clock.now(),
      member.membership,
    ]);
    await run(kit.env.DB, 'UPDATE api_keys SET revoked_at = ? WHERE id = ?', [
      kit.clock.now(),
      key.id,
    ]);
    for (const resource of ['events', 'devices']) {
      const path = `${ORIGIN}/api/v1/passes/${pass.id}/${resource}`;
      expect((await app.request(path, { headers: member.session.headers }, kit.env)).status).toBe(
        404,
      );
      expect((await app.request(path, { headers: key.headers }, kit.env)).status).toBe(401);
    }
    const revokedSession = await eventMember(kit, kit.org.id);
    await run(kit.env.DB, 'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?', [
      kit.clock.now(),
      await sha256Hex(revokedSession.session.cookieValue),
    ]);
    for (const resource of ['events', 'devices']) {
      const path = `${ORIGIN}/api/v1/passes/${pass.id}/${resource}`;
      expect(
        (await app.request(path, { headers: revokedSession.session.headers }, kit.env)).status,
      ).toBe(401);
    }
  });

  it('returns each event with its mode, in either caller mode', async () => {
    const pass = await kit.pass();
    await recordPassEvent(kit.ctx, { ...base(pass.id), mode: 'test', kind: 'email.captured' });
    for (const headers of [
      credentials.member.session.headers,
      { ...credentials.member.session.headers, 'x-passbook-mode': 'test' },
      credentials.key.headers,
    ]) {
      const page = PassEventListSchema.parse(await (await events(pass.id, headers)).json());
      expect(page.items.map((e) => e.mode)).toEqual(['test', 'live']);
    }
    // A key of the other mode does not see the pass at all.
    const testKey = await makeApiKey(kit.fx, { orgId: kit.org.id, mode: 'test' });
    expect((await events(pass.id, testKey.headers)).status).toBe(404);
  });
});

describe('event DTO', () => {
  it('never returns authority, proof, csrf or keyset fields, including on old rows', async () => {
    const pass = await kit.pass();
    const data = {
      title: 'Door',
      authority: { scannerRevision: 3, sessionCsrfProof: 'x' },
      nested: { keep: 1, scannerCsrfProof: 'y', credentialKeysetCommitment: 'z' },
      list: [{ undoProof: 'p', ok: true }],
    };
    await run(
      kit.env.DB,
      `INSERT INTO pass_events (id, org_id, pass_id, mode, kind, device, actor_type, actor_id, data, at)
       VALUES (?, ?, ?, 'live', 'email.captured', NULL, NULL, NULL, ?, ?)`,
      ['legacy-door-row', kit.org.id, pass.id, JSON.stringify(data), kit.clock.now()],
    );
    const res = await events(pass.id, credentials.member.session.headers);
    const page = PassEventListSchema.parse(await res.json());
    const item = page.items.find((e) => e.id === 'legacy-door-row');
    expect(item?.data).toEqual({ title: 'Door', nested: { keep: 1 }, list: [{ ok: true }] });
    expect(JSON.stringify(page)).not.toMatch(/authority|proof|csrf|keyset/i);
  });
});

describe('publish records pass.issued and pass.updated', () => {
  it('writes version, cause, source and notified', async () => {
    const { publishPass } = await import('../passes/publish.ts');
    const pass = await kit.pass();
    kit.clock.advance(1000);
    await publishPass(jobCtxOf(kit), {
      passId: pass.id,
      cause: 'admin',
      source: 'broadcast',
      actor: { type: 'system', id: null },
      mutate: () => ({ personalization: { memberName: 'Changed' } }),
    });
    const list = await rows(pass.id);
    expect(list.map((r) => r.kind)).toEqual(['pass.issued', 'pass.updated', 'push.queued']);
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
    await publishPass(jobCtxOf(kit), {
      passId: pass.id,
      cause: 'admin',
      actor: { type: 'system', id: null },
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
    await publishPass(jobCtxOf(kit), {
      passId: pass.id,
      cause: 'admin',
      notify: true,
      actor: { type: 'system', id: null },
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
