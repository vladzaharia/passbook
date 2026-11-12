import { beforeAll, describe, expect, it } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import {
  type BroadcastDto,
  BroadcastItemListSchema,
  BroadcastSchema,
} from '../../../shared/contracts/index.ts';
import { createApp } from '../../app.ts';
import { all, first, run } from '../../platform/db.ts';
import { runBroadcast } from '../../workflows/broadcast.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { applyChunk, CHUNK } from './apply.ts';
import { getBroadcast } from './repo.ts';
import { finishBroadcast, startedBroadcast } from './run.ts';
import { failStuckBroadcasts, launchBroadcast } from './start.ts';
import {
  addBroadcastAdminMembership,
  type BroadcastAuth,
  type BroadcastKit,
  broadcastAuth,
  broadcastKit,
} from './test-kit.ts';

const ORIGIN = 'https://wallet.test';
let auth: BroadcastAuth;
let kit: BroadcastKit;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  kit = await broadcastKit();
  auth = await broadcastAuth(kit, ORIGIN);
  app = createApp({ stores: auth.stores });
});

type Headers = Record<string, string>;
const api = (path: string, init: RequestInit & { headers?: Headers } = {}) =>
  app.request(`${ORIGIN}/api/v1${path}`, init, kit.env);
const send = (method: string, path: string, headers: Headers, body?: unknown) =>
  api(path, {
    method,
    headers: { ...headers, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const dto = async (res: Response) => BroadcastSchema.parse(await res.json());
const stepRun = {
  do: async (_n: string, a: unknown, b?: unknown) =>
    await ((typeof a === 'function' ? a : b) as () => Promise<unknown>)(),
} as unknown as Parameters<typeof runBroadcast>[3];
const body = (text: string, extra: Record<string, unknown> = {}) => ({
  orgId: kit.org.id,
  kind: 'message',
  target: { templateIds: [kit.messaging.id] },
  patch: { message: text },
  ...extra,
});
const isolate = (keep: string[]) =>
  run(
    kit.env.DB,
    `UPDATE passes SET status = 'voided' WHERE template_id = ? AND id NOT IN (${keep.map(() => '?').join(',')})`,
    [kit.messaging.id, ...keep],
  );
const get = async (id: string): Promise<BroadcastDto> =>
  dto(await api(`/broadcasts/${id}`, { headers: auth.admin() }));

describe('finish retry', () => {
  it('a retried finish step still creates the clearing follow-up', async () => {
    const pass = await kit.makePass();
    await isolate([pass.id]);
    const made = await dto(
      await send(
        'POST',
        '/broadcasts',
        auth.admin(),
        body('Closed today', { clearAfter: 3_600_000 }),
      ),
    );
    const instance = `broadcast-${made.id}`;
    await startedBroadcast(jobCtxOf(kit), instance, made.id);
    await applyChunk(jobCtxOf(kit), made.id, null);
    // The first finish settles the state but dies before the follow-up exists.
    await run(kit.env.DB, 'UPDATE broadcasts SET state = ? WHERE id = ?', ['sent', made.id]);
    expect(
      await first(kit.env.DB, 'SELECT id FROM broadcasts WHERE parent_id = ?', [made.id]),
    ).toBeNull();
    await finishBroadcast(jobCtxOf(kit), instance, made.id);
    await finishBroadcast(jobCtxOf(kit), instance, made.id);
    const followUps = await all(kit.env.DB, 'SELECT id FROM broadcasts WHERE parent_id = ?', [
      made.id,
    ]);
    expect(followUps).toHaveLength(1);
  });
});

describe('chunk budget', () => {
  it('spends well under the 1,000 D1 queries a step may use', async () => {
    const passes = await Promise.all(Array.from({ length: CHUNK }, () => kit.makePass()));
    await isolate(passes.map((p) => p.id));
    const made = await dto(
      await send('POST', '/broadcasts', auth.admin(), body('Budget', { send: 'draft' })),
    );
    await run(kit.env.DB, `UPDATE broadcasts SET state = 'sending' WHERE id = ?`, [made.id]);
    let queries = 0;
    const db = kit.env.DB;
    const original = db.prepare.bind(db);
    const counted = (statement: D1PreparedStatement) =>
      new Proxy(statement, {
        get(target, key) {
          const value = Reflect.get(target, key);
          if (typeof value !== 'function') return value;
          if (['run', 'all', 'first', 'raw'].includes(String(key)))
            return (...args: unknown[]) => {
              queries++;
              return value.apply(target, args);
            };
          if (key === 'bind') return (...args: unknown[]) => counted(value.apply(target, args));
          return value.bind(target);
        },
      });
    db.prepare = (sql: string) => counted(original(sql));
    const batch = db.batch.bind(db);
    db.batch = (statements) => {
      queries++;
      return batch(statements);
    };
    try {
      await applyChunk(jobCtxOf(kit), made.id, null);
    } finally {
      db.prepare = original;
      db.batch = batch;
    }
    expect(queries).toBeGreaterThan(CHUNK);
    // About 30 queries a pass at most: the whole chunk stays inside the queue budget of 800.
    expect(queries).toBeLessThan(CHUNK * 30);
    expect(CHUNK * 30).toBeLessThanOrEqual(800);
  }, 60_000);
});

describe('mode', () => {
  it('send, cancel, edit and send again need the broadcast mode', async () => {
    const draft = await dto(
      await send(
        'POST',
        '/broadcasts',
        auth.admin({ mode: 'test' }),
        body('Test only', { send: 'draft' }),
      ),
    );
    expect(draft.mode).toBe('test');
    const live = auth.admin();
    for (const [method, path] of [
      ['POST', `/broadcasts/${draft.id}/send`],
      ['POST', `/broadcasts/${draft.id}/cancel`],
      ['POST', `/broadcasts/${draft.id}/retry`],
      ['PATCH', `/broadcasts/${draft.id}`],
    ] as const) {
      const res = await send(method, path, live, method === 'PATCH' ? body('x') : {});
      expect(res.status).toBe(409);
      expect(((await res.json()) as { code: string }).code).toBe('MODE_MISMATCH');
    }
    expect(
      (await send('POST', `/broadcasts/${draft.id}/cancel`, auth.admin({ mode: 'test' }))).status,
    ).toBe(200);
  });

  it('send again copies the row in its own mode, even for a two-line message', async () => {
    const test = auth.admin({ mode: 'test' });
    const made = await dto(await send('POST', '/broadcasts', test, body('Line one\nLine two')));
    expect(made.name).toBe('Line one Line two');
    await run(kit.env.DB, `UPDATE broadcasts SET state = 'failed', name = ? WHERE id = ?`, [
      'Line one\nLine two',
      made.id,
    ]);
    const again = await send('POST', `/broadcasts/${made.id}/retry`, test);
    expect(again.status).toBe(201);
    const copy = await dto(again);
    expect(copy).toMatchObject({ mode: 'test', name: 'Line one Line two', patch: made.patch });
    expect(copy.id).not.toBe(made.id);
    expect((await send('POST', `/broadcasts/${copy.id}/retry`, test)).status).toBe(409);
  });
});

describe('edit', () => {
  it('replaces a draft or scheduled message, and nothing that started', async () => {
    const draft = await dto(
      await send('POST', '/broadcasts', auth.admin(), body('First', { send: 'draft' })),
    );
    const at = kit.clock.now() + 3_600_000;
    const edited = await send(
      'PATCH',
      `/broadcasts/${draft.id}`,
      auth.admin(),
      body('Second', { send: 'schedule', at, name: 'Renamed' }),
    );
    expect(edited.status).toBe(200);
    expect(await dto(edited)).toMatchObject({
      id: draft.id,
      state: 'scheduled',
      at,
      name: 'Renamed',
      patch: { message: 'Second' },
    });
    const elsewhere = await makeOrg(kit.fx, { name: 'Elsewhere' });
    await addBroadcastAdminMembership(kit, elsewhere.id);
    const other = body('x', { send: 'draft', orgId: elsewhere.id });
    expect((await send('PATCH', `/broadcasts/${draft.id}`, auth.admin(), other)).status).toBe(422);
    await run(kit.env.DB, `UPDATE broadcasts SET state = 'sending' WHERE id = ?`, [draft.id]);
    const late = await send('PATCH', `/broadcasts/${draft.id}`, auth.admin(), body('Third'));
    expect(late.status).toBe(409);
  });
});

describe('items', () => {
  it('lists the per-pass outcomes, by outcome, with holder and silent', async () => {
    const a = await kit.makePass();
    const b = await kit.makePass({ message: 'Same' });
    await isolate([a.id, b.id]);
    const made = await dto(await send('POST', '/broadcasts', auth.admin(), body('Same')));
    await runBroadcast(kit.env, `broadcast-${made.id}`, { broadcastId: made.id }, stepRun);
    await kit.settle();
    const all_ = BroadcastItemListSchema.parse(
      await (await api(`/broadcasts/${made.id}/items`, { headers: auth.admin() })).json(),
    );
    expect(all_.items.map((i) => i.outcome).sort()).toEqual(['unchanged', 'updated']);
    const updated = BroadcastItemListSchema.parse(
      await (
        await api(`/broadcasts/${made.id}/items?outcome=updated`, { headers: auth.admin() })
      ).json(),
    );
    expect(updated.items).toMatchObject([{ passId: a.id, outcome: 'updated', silent: false }]);
    const page = BroadcastItemListSchema.parse(
      await (await api(`/broadcasts/${made.id}/items?limit=1`, { headers: auth.admin() })).json(),
    );
    expect(page.nextCursor).not.toBeNull();
    expect((await api('/broadcasts/missing/items', { headers: auth.admin() })).status).toBe(404);
  });

  it('keeps successful and failed pass outcomes when a send is partial', async () => {
    const valid = await kit.makePass();
    const invalid = await kit.makePass();
    await isolate([valid.id, invalid.id]);
    // Model a previously stored pass whose input no longer meets the template's schema.
    await run(kit.env.DB, 'UPDATE passes SET personalization = ? WHERE id = ?', [
      JSON.stringify({ memberName: '' }),
      invalid.id,
    ]);
    const made = await dto(await send('POST', '/broadcasts', auth.admin(), body('Partial')));
    await runBroadcast(kit.env, `broadcast-${made.id}`, { broadcastId: made.id }, stepRun);
    await kit.settle();
    expect(await get(made.id)).toMatchObject({
      state: 'partial',
      counts: { targeted: 2, updated: 1, unchanged: 0, failed: 1 },
    });
    const items = BroadcastItemListSchema.parse(
      await (await api(`/broadcasts/${made.id}/items`, { headers: auth.admin() })).json(),
    );
    expect(items.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ passId: valid.id, outcome: 'updated' }),
        expect.objectContaining({ passId: invalid.id, outcome: 'failed' }),
      ]),
    );
    expect((await getPass(kit.env.DB, invalid.id, null))?.version).toBe(1);
  });
});

describe('items access', () => {
  it('needs passes:read for a key, and the key mode', async () => {
    const pass = await kit.makePass();
    await isolate([pass.id]);
    const made = await dto(await send('POST', '/broadcasts', auth.admin(), body('Same')));
    const url = `/broadcasts/${made.id}/items`;
    const blind = await auth.apiKey({ orgId: kit.org.id, scopes: ['messages:write'] });
    expect((await api(url, { headers: blind })).status).toBe(403);
    const reader = await auth.apiKey({
      orgId: kit.org.id,
      scopes: ['messages:write', 'passes:read'],
    });
    expect((await api(url, { headers: reader })).status).toBe(200);
    const testKey = await auth.apiKey({
      orgId: kit.org.id,
      scopes: ['messages:write', 'passes:read'],
      mode: 'test',
    });
    expect((await api(url, { headers: testKey })).status).toBe(404);
    // Sessions read either mode by id, as for GET /broadcasts/{id}.
    expect((await api(url, { headers: auth.admin({ mode: 'test' }) })).status).toBe(200);
  });
});

describe('launch checks', () => {
  it('fails a send whose org was suspended or whose creator was revoked', async () => {
    const pass = await kit.makePass();
    await isolate([pass.id]);
    const key = await auth.apiKey({ orgId: kit.org.id, scopes: ['messages:write'] });
    const keyed = await dto(
      await send(
        'POST',
        '/broadcasts',
        key,
        body('By key', { send: 'schedule', at: kit.clock.now() + 60_000 }),
      ),
    );
    const keyId = (
      await first<{ created_by_id: string }>(
        kit.env.DB,
        'SELECT created_by_id FROM broadcasts WHERE id = ?',
        [keyed.id],
      )
    )?.created_by_id;
    await run(kit.env.DB, 'UPDATE api_keys SET revoked_at = 1 WHERE id = ?', [keyId ?? '']);
    kit.clock.advance(120_000);
    expect(await launchBroadcast(jobCtxOf(kit), { id: keyed.id, org_id: kit.org.id })).toBe(false);
    expect(await get(keyed.id)).toMatchObject({ state: 'failed', errorCode: 'CREATOR_REVOKED' });

    const sched = await dto(
      await send(
        'POST',
        '/broadcasts',
        auth.admin(),
        body('Org', { send: 'schedule', at: kit.clock.now() + 60_000 }),
      ),
    );
    await run(kit.env.DB, `UPDATE orgs SET status = 'suspended' WHERE id = ?`, [kit.org.id]);
    kit.clock.advance(120_000);
    expect(await launchBroadcast(jobCtxOf(kit), { id: sched.id, org_id: kit.org.id })).toBe(false);
    await run(kit.env.DB, `UPDATE orgs SET status = 'active' WHERE id = ?`, [kit.org.id]);
    // The suspension trigger cancelled it before its time came; reactivation does not revive it.
    expect(await get(sched.id)).toMatchObject({ state: 'cancelled', errorCode: 'ORG_INACTIVE' });
    expect((await getPass(kit.env.DB, pass.id, null))?.personalization.message).toBeUndefined();
  });
});

describe('start races', () => {
  it('an instance that finds the send scheduled takes it over, and a skip finishes its run', async () => {
    const pass = await kit.makePass();
    await isolate([pass.id]);
    const made = await dto(
      await send(
        'POST',
        '/broadcasts',
        auth.admin(),
        body('Race', { send: 'schedule', at: kit.clock.now() + 60_000 }),
      ),
    );
    kit.clock.advance(120_000);
    const done = await runBroadcast(
      kit.env,
      `broadcast-${made.id}`,
      { broadcastId: made.id },
      stepRun,
    );
    expect(done.state).toBe('sent');
    expect((await get(made.id)).counts.updated).toBe(1);

    const cancelled = await dto(
      await send('POST', '/broadcasts', auth.admin(), body('Never', { send: 'draft' })),
    );
    await send('POST', `/broadcasts/${cancelled.id}/cancel`, auth.admin());
    await run(
      kit.env.DB,
      `INSERT OR IGNORE INTO workflow_runs (instance_id, kind, status, started_at) VALUES (?, 'broadcast', 'queued', 0)`,
      [`broadcast-${cancelled.id}`],
    ).catch(() => undefined);
    expect(
      (
        await runBroadcast(
          kit.env,
          `broadcast-${cancelled.id}`,
          { broadcastId: cancelled.id },
          stepRun,
        )
      ).state,
    ).toBe('skipped');
  });

  it('counts a pass a crashed run already published as updated, not unchanged', async () => {
    const pass = await kit.makePass();
    await isolate([pass.id]);
    const made = await dto(
      await send('POST', '/broadcasts', auth.admin(), body('Crash safe', { send: 'draft' })),
    );
    await run(kit.env.DB, `UPDATE broadcasts SET state = 'sending', started_at = ? WHERE id = ?`, [
      kit.clock.now(),
      made.id,
    ]);
    await applyChunk(jobCtxOf(kit), made.id, null);
    await run(kit.env.DB, 'DELETE FROM broadcast_items WHERE broadcast_id = ?', [made.id]);
    await applyChunk(jobCtxOf(kit), made.id, null);
    const row = await getBroadcast(kit.env.DB, made.id, null);
    expect(row?.state).toBe('sending');
    const item = await first<{ outcome: string }>(
      kit.env.DB,
      'SELECT outcome FROM broadcast_items WHERE broadcast_id = ?',
      [made.id],
    );
    expect(item?.outcome).toBe('updated');
  });
});

describe('stuck sweep', () => {
  it('checks the least recently checked sends first', async () => {
    (kit.env as unknown as { BROADCAST: Record<string, unknown> }).BROADCAST.get = async (
      id: string,
    ) => ({
      status: async () => ({ status: id.endsWith('dead') ? 'errored' : 'running' }),
    });
    const base = kit.clock.now() - 3_600_000;
    const insert = (id: string, startedAt: number) =>
      run(
        kit.env.DB,
        `INSERT INTO broadcasts (id, org_id, mode, kind, name, state, target, patch, created_at, started_at)
         VALUES (?, ?, 'live', 'message', 'Long', 'sending', '{"templateIds":[]}', '{"message":"x"}', ?, ?)`,
        [id, kit.org.id, startedAt, startedAt],
      );
    for (let i = 0; i < 22; i++) await insert(`long-${String(i).padStart(2, '0')}`, base + i);
    await insert('late-dead', base + 100);
    await failStuckBroadcasts(jobCtxOf(kit));
    await failStuckBroadcasts(jobCtxOf(kit));
    expect((await getBroadcast(kit.env.DB, 'late-dead', null))?.state).toBe('failed');
  });
});
