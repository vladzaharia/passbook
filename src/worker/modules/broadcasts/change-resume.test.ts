import { beforeAll, describe, expect, it, vi } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { all, first, run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { recordPassEvent } from '../events/record.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { applyChunk } from './apply.ts';
import { type ChangeKit, changeKit } from './change-fixtures.ts';

vi.mock('../events/record.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../events/record.ts')>();
  return { ...actual, recordPassEvent: vi.fn(actual.recordPassEvent) };
});

let ck: ChangeKit;
beforeAll(async () => {
  ck = await changeKit();
});

const points = async (id: string) =>
  (await getPass(ck.kit.env.DB, id, null))?.personalization.points;
const create = async (passIds: string[], extra: Record<string, unknown> = {}) => {
  const res = await ck.post('/broadcasts', {
    orgId: ck.kit.org.id,
    kind: 'change',
    target: { passIds },
    patch: { points: { add: 5 } },
    ...extra,
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
};
const three = async () => [
  await ck.kit.makePass({ points: 10 }),
  await ck.kit.makePass({ points: 10 }),
  await ck.kit.makePass({ points: 10 }),
];

describe('resuming a change', () => {
  it('stop after two, resume: no pass gets the add twice', async () => {
    const passes = await three();
    const ids = passes.map((p) => p.id);
    const id = await create(ids);
    await applyChunk(jobCtxOf(ck.kit), id, null, 2);
    expect((await ck.post(`/broadcasts/${id}/stop`)).status).toBe(200);
    await ck.runNext();
    expect(await ck.get(id)).toMatchObject({ state: 'cancelled', counts: { updated: 2 } });

    await expectProblem(await ck.post(`/broadcasts/${id}/retry`), 422, 'EXPECT_COUNT_REQUIRED');
    await expectProblem(
      await ck.post(`/broadcasts/${id}/retry?expectCount=9`),
      409,
      'SELECTION_CHANGED',
    );
    const res = await ck.post(`/broadcasts/${id}/retry?expectCount=1`);
    expect(res.status).toBe(201);
    await ck.runNext();
    const resumed = await ck.get(((await res.json()) as { id: string }).id);
    expect(resumed).toMatchObject({ state: 'sent', counts: { targeted: 1, updated: 1 } });
    for (const pass of passes) expect(await points(pass.id)).toBe(15);
  });

  it('a change that failed SELECTION_CHANGED is made again, not retried', async () => {
    const [a] = await three();
    const id = await create([a?.id ?? ''], { send: 'draft' });
    await run(
      ck.kit.env.DB,
      "UPDATE broadcasts SET state = 'failed', error_code = 'SELECTION_CHANGED' WHERE id = ?",
      [id],
    );
    await expectProblem(
      await ck.post(`/broadcasts/${id}/retry?expectCount=1`),
      409,
      'BROADCAST_NOT_RETRYABLE',
    );
  });
});

describe('a step that dies between the write and its item', () => {
  it('retries without applying twice and keeps the earlier values', async () => {
    const [a] = await three();
    const id = await create([a?.id ?? '']);
    const crash = vi.mocked(recordPassEvent);
    const real = crash.getMockImplementation();
    crash.mockImplementation(async (ctx, event) => {
      if (event.kind === 'schedule.applied') throw new Error('isolate evicted');
      return real?.(ctx, event) as never;
    });
    await expect(applyChunk(jobCtxOf(ck.kit), id, null)).rejects.toThrow('isolate evicted');
    crash.mockImplementation(real as never);
    expect(await points(a?.id ?? '')).toBe(15);
    expect(await ck.items(id)).toEqual([]);
    await applyChunk(jobCtxOf(ck.kit), id, null);
    expect(await points(a?.id ?? '')).toBe(15);
    const [item] = await ck.items(id);
    expect(item).toMatchObject({ outcome: 'updated' });
    expect(JSON.parse(item?.before ?? '{}')).toMatchObject({
      from: { points: 10 },
      to: { points: 15 },
    });
    const left = await all(
      ck.kit.env.DB,
      'SELECT 1 FROM broadcast_targets WHERE broadcast_id = ? AND intent IS NOT NULL',
      [id],
    );
    expect(left).toEqual([]);
  });
});

describe('the selection is rows, not target JSON', () => {
  it('stores each chosen pass once and only the source in the target', async () => {
    const [a, b] = await three();
    const id = await create([a?.id ?? '', b?.id ?? '', a?.id ?? ''], { send: 'draft' });
    const rows = await all<{ pass_id: string }>(
      ck.kit.env.DB,
      'SELECT pass_id FROM broadcast_targets WHERE broadcast_id = ?',
      [id],
    );
    expect(rows).toHaveLength(2);
    const row = await first<{ target: string }>(
      ck.kit.env.DB,
      'SELECT target FROM broadcasts WHERE id = ?',
      [id],
    );
    expect(row?.target).not.toContain(a?.id);
    expect(JSON.parse(row?.target ?? '{}')).toMatchObject({ selection: 'ids' });
  });

  it('snapshots a template run at its start: a pass added later is not in it', async () => {
    const old = await ck.kit.makePass({ gate: 'S' });
    const res = await ck.post('/broadcasts', {
      orgId: ck.kit.org.id,
      kind: 'change',
      target: { templateIds: [ck.kit.messaging.id], match: [{ input: 'gate', values: ['S'] }] },
      patch: { points: { set: 1 } },
      send: 'draft',
    });
    const { id } = (await res.json()) as { id: string };
    await ck.post(`/broadcasts/${id}/send`, {});
    const late = await ck.kit.makePass({ gate: 'S' });
    await ck.runNext();
    expect(await points(old.id)).toBe(1);
    expect(await points(late.id)).toBe(1);
    expect((await ck.get(id)).counts.targeted).toBe(2);
  });
});

describe('notify and the rate limit', () => {
  it('a change tells nobody unless asked; a message still does', async () => {
    const [a] = await three();
    const id = await create([a?.id ?? ''], { send: 'draft' });
    expect((await ck.get(id)).notify).toBe(false);
    const msg = await ck.post('/broadcasts', {
      orgId: ck.kit.org.id,
      kind: 'message',
      send: 'draft',
      target: { templateIds: [ck.kit.messaging.id] },
      patch: { message: 'Hi' },
    });
    expect(((await msg.json()) as { notify: boolean }).notify).toBe(true);
  });

  it('limits sessions too, and a replay or a refused body does not use a slot', async () => {
    const [a] = await three();
    ck.state.spread = false;
    await run(ck.kit.env.DB, "DELETE FROM counters WHERE key LIKE 'change-run:%'");
    const headers = { ...ck.auth.admin(), 'idempotency-key': 'k-1' };
    const body = {
      orgId: ck.kit.org.id,
      kind: 'change',
      target: { passIds: [a?.id ?? ''] },
      patch: { points: { add: 1 } },
      send: 'draft',
    };
    for (let i = 0; i < 4; i++)
      expect((await ck.post('/broadcasts', { ...body, patch: { nope: 1 } })).status).toBe(422);
    expect((await ck.post('/broadcasts', body, headers)).status).toBe(201);
    expect((await ck.post('/broadcasts', body, headers)).status).toBe(201);
    let refused = 0;
    for (let i = 0; i < 8; i++) if ((await ck.post('/broadcasts', body)).status === 429) refused++;
    expect(refused).toBeGreaterThan(0);
    ck.state.spread = true;
  });
});

describe('the preview', () => {
  it('needs passes:read for a key', async () => {
    const [a] = await three();
    const key = await ck.auth.apiKey({
      orgId: ck.kit.org.id,
      scopes: ['messages:write', 'messages:read'],
    });
    await expectProblem(
      await ck.post(
        '/broadcasts/preview',
        { orgId: ck.kit.org.id, target: { passIds: [a?.id ?? ''] }, patch: { points: { add: 1 } } },
        key,
      ),
      403,
      'MISSING_SCOPE',
    );
  });
});

describe('an undo child', () => {
  it('cannot be edited or cancelled, and a stopped one is asked again', async () => {
    const passes = await three();
    const done = await ck.change({
      target: { passIds: passes.map((p) => p.id) },
      patch: { points: { add: 1 } },
    });
    const ask = (await (await ck.post(`/broadcasts/${done.id}/undo`)).json()) as { id: string };
    await run(ck.kit.env.DB, "UPDATE broadcasts SET state = 'scheduled' WHERE id = ?", [ask.id]);
    const edit = await ck.api(`/broadcasts/${ask.id}`, {
      method: 'PATCH',
      headers: { ...ck.auth.admin(), 'content-type': 'application/json' },
      body: JSON.stringify({
        orgId: ck.kit.org.id,
        kind: 'change',
        target: { passIds: [passes[0]?.id ?? ''] },
        patch: { points: { set: 0 } },
        send: 'draft',
      }),
    });
    expect(edit.status).toBe(409);
    await expectProblem(
      await ck.post(`/broadcasts/${ask.id}/cancel`),
      409,
      'BROADCAST_NOT_CANCELLABLE',
    );
    await run(
      ck.kit.env.DB,
      "UPDATE broadcasts SET state = 'cancelled', error_code = 'BROADCAST_STOPPED', finished_at = ? WHERE id = ?",
      [ck.kit.clock.now(), ask.id],
    );
    const before = ck.kit.broadcast.created.length;
    expect(
      ((await (await ck.post(`/broadcasts/${done.id}/undo`)).json()) as { id: string }).id,
    ).toBe(ask.id);
    expect(ck.kit.broadcast.created.length).toBe(before + 1);
  });
});

describe('a stopped message', () => {
  it('still schedules its clear when it reached any pass', async () => {
    await ck.kit.makePass();
    const res = await ck.post('/broadcasts', {
      orgId: ck.kit.org.id,
      kind: 'message',
      target: { templateIds: [ck.kit.messaging.id] },
      patch: { message: 'Doors open at 7' },
      clearAfter: 3_600_000,
    });
    const { id } = (await res.json()) as { id: string };
    await applyChunk(jobCtxOf(ck.kit), id, null, 1);
    await ck.post(`/broadcasts/${id}/stop`);
    await ck.runNext();
    expect(await ck.get(id)).toMatchObject({ state: 'cancelled' });
    expect((await ck.get(id)).followUp).not.toBeNull();
  });
});

describe('an import selection', () => {
  const insertImport = (id: string, state: string, reverted = 0) =>
    run(
      ck.kit.env.DB,
      `INSERT INTO pass_imports (id, org_id, mode, template_id, source_kind, source_name, state, reverted,
         created_by, created_at, expires_at) VALUES (?, ?, 'live', ?, 'file', 'a.csv', ?, ?, 'admin-1', ?, ?)`,
      [
        id,
        ck.kit.org.id,
        ck.kit.messaging.id,
        state,
        reverted,
        ck.kit.clock.now(),
        ck.kit.clock.now() + 1e9,
      ],
    );
  const ofImport = (importId: string) =>
    ck.post('/broadcasts', {
      orgId: ck.kit.org.id,
      kind: 'change',
      target: { importId },
      patch: { points: { set: 1 } },
      send: 'draft',
    });

  it('needs the import ended and not undone', async () => {
    await insertImport('imp-running', 'committing');
    await insertImport('imp-undone', 'done', 2);
    await insertImport('imp-done', 'done');
    await expectProblem(await ofImport('imp-running'), 409, 'IMPORT_NOT_ENDED');
    await expectProblem(await ofImport('imp-undone'), 409, 'IMPORT_NOT_ENDED');
    expect((await ofImport('imp-done')).status).toBe(201);
  });
});

describe('migration 0177', () => {
  it("copies an org's messages.perDay override to passes.changesPerDay", async () => {
    const { default: sql } = await import('../../../../migrations/0177_issuing_undo.sql?raw');
    const copy = /INSERT OR IGNORE INTO org_entitlement_overrides[^;]+;/.exec(sql)?.[0] ?? '';
    expect(copy).not.toBe('');
    await run(
      ck.kit.env.DB,
      "INSERT OR REPLACE INTO org_entitlement_overrides (org_id, key, value, updated_at) VALUES (?, 'messages.perDay', '0', 1)",
      [ck.kit.org.id],
    );
    await run(ck.kit.env.DB, copy);
    const row = await first<{ value: string }>(
      ck.kit.env.DB,
      "SELECT value FROM org_entitlement_overrides WHERE org_id = ? AND key = 'passes.changesPerDay'",
      [ck.kit.org.id],
    );
    expect(row?.value).toBe('0');
    await run(
      ck.kit.env.DB,
      "DELETE FROM org_entitlement_overrides WHERE org_id = ? AND key IN ('messages.perDay', 'passes.changesPerDay')",
      [ck.kit.org.id],
    );
  });
});
