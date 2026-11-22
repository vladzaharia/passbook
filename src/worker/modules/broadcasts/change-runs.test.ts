import { beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeOrg, setLimit } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { publishPass } from '../passes/publish.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { type ChangeKit, changeKit } from './change-fixtures.ts';
import { manualBroadcastsToday } from './repo-day-limit.ts';
import { startDueBroadcasts } from './start.ts';

let ck: ChangeKit;
let other: { id: string };
beforeAll(async () => {
  ck = await changeKit();
  other = await makeOrg(ck.kit.fx, { name: 'Other Org' });
});

const personalization = async (id: string) =>
  (await getPass(ck.kit.env.DB, id, null))?.personalization;
const lastJson = async (id: string) =>
  (
    await first<{ pass_json: string }>(
      ck.kit.env.DB,
      'SELECT pass_json FROM pass_versions WHERE pass_id = ? ORDER BY version DESC LIMIT 1',
      [id],
    )
  )?.pass_json ?? '';
const body = (extra: Record<string, unknown>) => ({
  orgId: ck.kit.org.id,
  kind: 'change',
  ...extra,
});

describe('a change run on chosen passes', () => {
  it('sets, shifts and adds by each pass, and keeps the earlier values for the undo', async () => {
    const a = await ck.kit.makePass({ gate: 'A', expires: '2026-01-31', points: 10 });
    const b = await ck.kit.makePass({ gate: 'A', expires: '2026-02-28', points: 5 });
    const done = await ck.change({
      target: { passIds: [a.id, b.id], expectCount: 2 },
      patch: { gate: { set: 'B' }, expires: { shift: 'P1M' }, points: { add: 5 } },
      notify: false,
    });
    expect(done.state).toBe('sent');
    expect(done.counts).toMatchObject({ targeted: 2, updated: 2, failed: 0 });
    expect(done.target.templateIds).toEqual([ck.kit.messaging.id]);
    expect(await personalization(a.id)).toMatchObject({
      gate: 'B',
      expires: '2026-02-28',
      points: 15,
    });
    expect(await personalization(b.id)).toMatchObject({ expires: '2026-03-28', points: 10 });
    const items = await ck.items(done.id);
    const at = (await getPass(ck.kit.env.DB, a.id, null))?.version;
    expect(items.find((i) => i.pass_id === a.id)).toMatchObject({
      outcome: 'updated',
      version: at,
    });
    expect(JSON.parse(items.find((i) => i.pass_id === a.id)?.before ?? '{}')).toEqual({
      from: { gate: 'A', expires: '2026-01-31', points: 10 },
      to: { gate: 'B', expires: '2026-02-28', points: 15 },
    });
  });

  it('clears an optional input and refuses to clear a required one', async () => {
    const a = await ck.kit.makePass({ gate: 'C' });
    const done = await ck.change({ target: { passIds: [a.id] }, patch: { gate: { clear: true } } });
    expect(done.counts.updated).toBe(1);
    expect((await personalization(a.id))?.gate).toBeUndefined();
    await expectProblem(
      await ck.post(
        '/broadcasts',
        body({ target: { passIds: [a.id] }, patch: { memberName: { clear: true } } }),
      ),
      422,
      'BROADCAST_INVALID_OP',
    );
  });

  it('fails a pass an op cannot read and still changes the others', async () => {
    const dated = await ck.kit.makePass({ expires: '2026-05-01' });
    const empty = await ck.kit.makePass();
    const done = await ck.change({
      target: { passIds: [dated.id, empty.id] },
      patch: { expires: { shift: '-P1D' } },
      notify: false,
    });
    expect(done.state).toBe('partial');
    expect(done.counts).toMatchObject({ updated: 1, failed: 1 });
    expect((await personalization(dated.id))?.expires).toBe('2026-04-30');
  });

  it('refuses ops the field cannot take', async () => {
    const a = await ck.kit.makePass();
    const send = (patch: Record<string, unknown>) =>
      ck.post('/broadcasts', body({ target: { passIds: [a.id] }, patch }));
    await expectProblem(await send({ gate: { shift: 'P1D' } }), 422, 'BROADCAST_INVALID_OP');
    await expectProblem(await send({ gate: { add: 1 } }), 422, 'BROADCAST_INVALID_OP');
    await expectProblem(await send({ points: { add: 1.5 } }), 422, 'BROADCAST_INVALID_OP');
    await expectProblem(await send({ nope: { set: 'x' } }), 422, 'BROADCAST_UNKNOWN_INPUT');
    expect((await send({ points: { shift: '1 year' } })).status).toBe(422);
  });

  it('a plain value in the patch still reads as a set', async () => {
    const a = await ck.kit.makePass({ gate: 'A' });
    const done = await ck.change({
      target: { passIds: [a.id] },
      patch: { gate: 'Z' },
      notify: false,
    });
    expect(done.counts.updated).toBe(1);
    expect((await personalization(a.id))?.gate).toBe('Z');
  });
});

describe('the lock-screen text', () => {
  it('reads each token from the pass and replaces the template message', async () => {
    const a = await ck.kit.makePass({ gate: 'A' });
    await ck.change({
      target: { passIds: [a.id] },
      patch: { gate: { set: 'Gate 9' } },
      notify: true,
      message: 'Go to {Gate} for 100%.',
    });
    const json = await lastJson(a.id);
    expect(json).toContain('"changeMessage":"Go to Gate 9 for 100%%. %@"');
    expect(json).not.toContain('Gate is now %@');
  });

  it('refuses an unknown token, and text without notify', async () => {
    const a = await ck.kit.makePass();
    const send = (extra: Record<string, unknown>) =>
      ck.post('/broadcasts', body({ target: { passIds: [a.id] }, patch: { gate: 'B' }, ...extra }));
    await expectProblem(
      await send({ message: 'Hi {Nope}', notify: true }),
      422,
      'BROADCAST_UNKNOWN_TOKEN',
    );
    expect((await send({ message: 'Hi', notify: false })).status).toBe(422);
  });
});

describe('selection', () => {
  it('refuses a count that drifted more than 2% with 409', async () => {
    const a = await ck.kit.makePass();
    const b = await ck.kit.makePass();
    await expectProblem(
      await ck.post(
        '/broadcasts',
        body({ target: { passIds: [a.id, b.id], expectCount: 9 }, patch: { gate: 'B' } }),
      ),
      409,
      'SELECTION_CHANGED',
    );
  });

  it('a scheduled run whose selection moved before it starts applies nothing', async () => {
    const a = await ck.kit.makePass({ gate: 'A' });
    const b = await ck.kit.makePass({ gate: 'A' });
    const at = ck.kit.clock.now() + 3_600_000;
    const res = await ck.post(
      '/broadcasts',
      body({
        target: { passIds: [a.id, b.id], expectCount: 2 },
        patch: { gate: 'B' },
        send: 'schedule',
        at,
      }),
    );
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    await run(ck.kit.env.DB, "UPDATE passes SET status = 'voided' WHERE id = ?", [b.id]);
    ck.kit.clock.advance(3_700_000);
    const before = ck.kit.broadcast.created.length;
    await startDueBroadcasts(ck.kit.ctx);
    expect(ck.kit.broadcast.created.length).toBe(before + 1);
    await ck.runNext();
    const done = await ck.get(id);
    expect(done).toMatchObject({ state: 'failed', errorCode: 'SELECTION_CHANGED' });
    expect((await personalization(a.id))?.gate).toBe('A');
  });

  it("is scoped to the org and mode: another org's pass and a test pass read as missing", async () => {
    const mine = await ck.kit.makePass();
    const theirs = await ck.kit.makePass({ orgId: other.id });
    const test = await ck.kit.makePass({ mode: 'test' });
    for (const passIds of [[mine.id, theirs.id], [test.id]])
      await expectProblem(
        await ck.post('/broadcasts', body({ target: { passIds }, patch: { gate: 'B' } })),
        404,
        'PASS_NOT_FOUND',
      );
    await expectProblem(
      await ck.post('/broadcasts', body({ target: { importId: 'nope' }, patch: { gate: 'B' } })),
      404,
      'IMPORT_NOT_FOUND',
    );
  });

  it('takes one selection only', async () => {
    const a = await ck.kit.makePass();
    const res = await ck.post(
      '/broadcasts',
      body({
        target: { passIds: [a.id], templateIds: [ck.kit.messaging.id] },
        patch: { gate: 'B' },
      }),
    );
    expect(res.status).toBe(422);
  });
});

describe('preview', () => {
  it('shows sample diffs, unchanged and blocked passes', async () => {
    const a = await ck.kit.makePass({ gate: 'A', expires: '2026-01-31' });
    const same = await ck.kit.makePass({ gate: 'B', expires: '2026-01-31' });
    const none = await ck.kit.makePass({ gate: 'A' });
    const res = await ck.post('/broadcasts/preview', {
      orgId: ck.kit.org.id,
      target: { passIds: [a.id, same.id, none.id] },
      patch: { gate: { set: 'B' }, expires: { shift: 'P1D' } },
      notify: true,
    });
    expect(res.status).toBe(200);
    const preview = (await res.json()) as Record<string, unknown>;
    expect(preview).toMatchObject({
      targeted: 3,
      unchanged: 0,
      blocked: [{ code: 'NO_VALUE', count: 1 }],
      notified: 0,
      silent: 2,
      estimated: true,
    });
    const samples = preview.samples as {
      passId: string;
      changes: { label: string; from: string; to: string }[];
    }[];
    expect(samples).toHaveLength(2);
    expect(samples.find((s) => s.passId === a.id)?.changes).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: 'Gate', from: 'A', to: 'B' })]),
    );
  });
});

describe('the daily cap', () => {
  it('counts change runs apart from messages (passes.changesPerDay)', async () => {
    const a = await ck.kit.makePass();
    const now = ck.kit.clock.now();
    await setLimit(
      ck.kit.env.DB,
      ck.kit.org.id,
      'passes.changesPerDay',
      await manualBroadcastsToday(ck.kit.env.DB, ck.kit.org.id, 'live', now, 'change'),
    );
    const res = await ck.post(
      '/broadcasts',
      body({ target: { passIds: [a.id] }, patch: { gate: 'B' } }),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('FEATURE_LIMIT_REACHED');
    const message = await ck.post('/broadcasts', {
      orgId: ck.kit.org.id,
      kind: 'message',
      send: 'draft',
      target: { templateIds: [ck.kit.messaging.id] },
      patch: { message: 'Hi' },
    });
    expect(message.status).toBe(201);
    await setLimit(ck.kit.env.DB, ck.kit.org.id, 'passes.changesPerDay', null);
  });
});

describe('the push budget', () => {
  it('updates a pass at its daily limit silently and counts it, and previews the split', async () => {
    const full = await ck.kit.makePass({ gate: 'A' });
    const fresh = await ck.kit.makePass({ gate: 'A' });
    for (const gate of ['A1', 'A2', 'A3'])
      await publishPass(jobCtxOf(ck.kit), {
        passId: full.id,
        cause: 'admin',
        actor: { type: 'system', id: null },
        notify: true,
        mutate: (p) => ({ personalization: { ...p.personalization, gate } }),
      });
    const preview = (await (
      await ck.post('/broadcasts/preview', {
        orgId: ck.kit.org.id,
        target: { passIds: [full.id, fresh.id] },
        patch: { gate: { set: 'Z' } },
        notify: true,
      })
    ).json()) as { notified: number; silent: number; overBudget: number };
    expect(preview).toMatchObject({ overBudget: 1, notified: 0, silent: 2 });
    const done = await ck.change({
      target: { passIds: [full.id, fresh.id] },
      patch: { gate: { set: 'Z' } },
      notify: true,
    });
    expect(done.counts).toMatchObject({ updated: 2, overBudget: 1 });
    const items = await ck.items(done.id);
    expect(items.find((i) => i.pass_id === full.id)?.silent).toBe(1);
    expect(items.find((i) => i.pass_id === fresh.id)?.silent).toBe(0);
  });
});

describe('history', () => {
  it("reads a change run's write as source schedule", async () => {
    const a = await ck.kit.makePass({ gate: 'A' });
    await ck.change({ target: { passIds: [a.id] }, patch: { gate: 'B' } });
    const row = await first<{ source: string }>(
      ck.kit.env.DB,
      'SELECT source FROM pass_versions WHERE pass_id = ? ORDER BY version DESC LIMIT 1',
      [a.id],
    );
    expect(row?.source).toMatch(/^schedule:/);
    const res = await ck.api(`/passes/${a.id}`, { headers: ck.auth.admin() });
    const body = (await res.json()) as { versions: { source: string | null }[] };
    expect(body.versions[0]?.source).toBe('schedule');
  });
});
