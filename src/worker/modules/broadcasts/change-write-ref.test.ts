import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Json } from '../../../shared/contracts/common.ts';
import { all, first, run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { publishPass } from '../passes/publish.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { applyChunk } from './apply.ts';
import { type ChangeKit, changeKit } from './change-fixtures.ts';
import { settlePending } from './change-intent.ts';
import type { BroadcastRow } from './repo.ts';
import * as repo from './repo.ts';

vi.mock('./repo.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./repo.ts')>();
  return {
    ...actual,
    insertItems: vi.fn(actual.insertItems),
    setIntent: vi.fn(actual.setIntent),
  };
});

let ck: ChangeKit;
beforeAll(async () => {
  ck = await changeKit();
});

const input = async (id: string, key: string) =>
  (await getPass(ck.kit.env.DB, id, null))?.personalization[key];
const versions = (id: string) =>
  all(ck.kit.env.DB, 'SELECT version FROM pass_versions WHERE pass_id = ?', [id]);
const edit = (passId: string, values: Record<string, Json>) =>
  publishPass(jobCtxOf(ck.kit), {
    passId,
    cause: 'admin',
    actor: { type: 'user', id: 'admin-1' },
    notify: false,
    mutate: (p) => ({ personalization: { ...p.personalization, ...values } }),
  });

// `visits` and `note` are bound to no field, so writing them stores the input with no pass_versions row.
const unrendered = async (values: Record<string, Json> = { visits: 0 }) => {
  const pass = await ck.kit.makePass();
  await edit(pass.id, values);
  return pass.id;
};
const start = async (passId: string, patch: Record<string, unknown> = { visits: { add: 1 } }) => {
  const res = await ck.post('/broadcasts', {
    orgId: ck.kit.org.id,
    kind: 'change',
    target: { passIds: [passId] },
    patch,
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
};
const crashBeforeItem = async (id: string) => {
  const insert = vi.mocked(repo.insertItems);
  const real = insert.getMockImplementation();
  insert.mockImplementationOnce(async () => {
    throw new Error('isolate evicted');
  });
  await expect(applyChunk(jobCtxOf(ck.kit), id, null)).rejects.toThrow('isolate evicted');
  insert.mockImplementation(real as never);
};
/** Runs `during` right after the next intent is written: between the run's read and its write. */
const afterIntent = (during: () => Promise<unknown>) => {
  const set = vi.mocked(repo.setIntent);
  const real = set.getMockImplementation() as typeof repo.setIntent;
  set.mockImplementationOnce(async (...args) => {
    await real(...args);
    await during();
  });
};
/** Ends the run after a manual pass over it, as its workflow would. */
const finish = () => ck.runNext().catch(() => undefined);
const beforeOf = async (id: string) => {
  const [item] = await ck.items(id);
  return { item, before: JSON.parse(item?.before ?? '{}') };
};

describe('a metadata-only write that crashes before its item', () => {
  it('is settled from its own write, never added twice', async () => {
    const passId = await unrendered();
    const id = await start(passId);
    const stored = (await versions(passId)).length;
    await crashBeforeItem(id);
    expect(await input(passId, 'visits')).toBe(1);
    expect((await versions(passId)).length).toBe(stored);
    await applyChunk(jobCtxOf(ck.kit), id, null);
    expect(await input(passId, 'visits')).toBe(1);
    const { item, before } = await beforeOf(id);
    expect(item).toMatchObject({ outcome: 'updated' });
    expect(before).toMatchObject({ from: { visits: 0 }, to: { visits: 1 } });
  });

  it('counts as updated with and without a crash', async () => {
    const a = await unrendered();
    const b = await unrendered();
    const clean = await start(a);
    await applyChunk(jobCtxOf(ck.kit), clean, null);
    const crashed = await start(b);
    await crashBeforeItem(crashed);
    await applyChunk(jobCtxOf(ck.kit), crashed, null);
    const [x] = await ck.items(clean);
    const [y] = await ck.items(crashed);
    expect(x).toMatchObject({ outcome: 'updated' });
    expect(y).toMatchObject({ outcome: 'updated' });
    expect(JSON.parse(x?.before ?? '{}')).toEqual(JSON.parse(y?.before ?? '{}'));
  });

  it('an unrelated write between the crashed write and the resume does not hide it', async () => {
    const passId = await unrendered();
    const id = await start(passId);
    await crashBeforeItem(id);
    await edit(passId, { note: 'x' });
    await applyChunk(jobCtxOf(ck.kit), id, null);
    expect(await input(passId, 'visits')).toBe(1);
    expect(await ck.items(id)).toHaveLength(1);
  });

  it("another run's write to the pass does not hide the first run's", async () => {
    const passId = await unrendered();
    const a = await start(passId);
    await crashBeforeItem(a);
    const b = await start(passId);
    await applyChunk(jobCtxOf(ck.kit), b, null);
    expect(await input(passId, 'visits')).toBe(2);
    await applyChunk(jobCtxOf(ck.kit), a, null);
    expect(await input(passId, 'visits')).toBe(2);
    expect(await ck.items(a)).toHaveLength(1);
    expect(await ck.items(b)).toHaveLength(1);
  });

  it('is undone exactly after it was settled', async () => {
    const passId = await unrendered();
    const id = await start(passId);
    await crashBeforeItem(id);
    await applyChunk(jobCtxOf(ck.kit), id, null);
    await finish();
    expect((await ck.post(`/broadcasts/${id}/undo`)).status).toBe(200);
    await ck.runNext();
    expect(await input(passId, 'visits')).toBe(0);
  });

  it('restores the earlier value of a set and of a clear on an unbound input', async () => {
    for (const [op, after] of [
      [{ set: 'run' }, 'run'],
      [{ clear: true }, undefined],
    ] as const) {
      const passId = await unrendered({ note: 'a' });
      const id = await start(passId, { note: op });
      await crashBeforeItem(id);
      await applyChunk(jobCtxOf(ck.kit), id, null);
      expect(await input(passId, 'note')).toBe(after);
      expect((await beforeOf(id)).before).toMatchObject({ from: { note: 'a' } });
      await finish();
      expect((await ck.post(`/broadcasts/${id}/undo`)).status).toBe(200);
      await ck.runNext();
      expect(await input(passId, 'note')).toBe('a');
    }
  });
});

describe('a write between the run read and the run write', () => {
  it('settles with what the write replaced, and the undo keeps nothing stale', async () => {
    const passId = await unrendered({ note: 'a' });
    const id = await start(passId, { note: { set: 'run' } });
    afterIntent(() => edit(passId, { note: 'admin' }));
    await crashBeforeItem(id);
    expect(await input(passId, 'note')).toBe('run');
    await applyChunk(jobCtxOf(ck.kit), id, null);
    expect((await beforeOf(id)).before).toMatchObject({
      from: { note: 'admin' },
      to: { note: 'run' },
    });
    await finish();
    expect((await ck.post(`/broadcasts/${id}/undo`)).status).toBe(200);
    await ck.runNext();
    expect(await input(passId, 'note')).toBe('admin');
  });
});

describe('a stale attempt', () => {
  it('stops when a newer attempt already recorded the item', async () => {
    const passId = await unrendered();
    const id = await start(passId);
    // The first attempt has read the pass and written its intent; a newer attempt then runs the pass to the end.
    afterIntent(async () => {
      await applyChunk(jobCtxOf(ck.kit), id, null);
    });
    await applyChunk(jobCtxOf(ck.kit), id, null);
    expect(await input(passId, 'visits')).toBe(1);
    expect(await ck.items(id)).toHaveLength(1);
    expect((await ck.items(id))[0]).toMatchObject({ outcome: 'updated' });
  });
});

describe('the trigger on passes', () => {
  const stamp = async (runId: string, passId: string) =>
    first<{ written_version: number | null }>(
      ck.kit.env.DB,
      'SELECT written_version FROM broadcast_targets WHERE broadcast_id = ? AND pass_id = ?',
      [runId, passId],
    );
  const target = async () => {
    const passId = await unrendered();
    const id = await start(passId);
    await run(
      ck.kit.env.DB,
      'UPDATE broadcast_targets SET intent = ? WHERE broadcast_id = ? AND pass_id = ?',
      [JSON.stringify({ from: { visits: 0 }, to: { visits: 1 }, version: 1 }), id, passId],
    );
    return { passId, id };
  };

  it('never stamps for a write that is not a run write', async () => {
    const { passId, id } = await target();
    await edit(passId, { note: 'y' });
    expect(await stamp(id, passId)).toEqual({ written_version: null });
  });

  it('never stamps a write that matched no row, or a target without an intent', async () => {
    const { passId, id } = await target();
    await run(
      ck.kit.env.DB,
      'UPDATE passes SET write_ref = ?, version = version + 1 WHERE id = ? AND version = -1',
      [id, passId],
    );
    expect(await stamp(id, passId)).toEqual({ written_version: null });
    await run(
      ck.kit.env.DB,
      'UPDATE broadcast_targets SET intent = NULL WHERE broadcast_id = ? AND pass_id = ?',
      [id, passId],
    );
    await run(ck.kit.env.DB, 'UPDATE passes SET write_ref = ? WHERE id = ?', [id, passId]);
    expect(await stamp(id, passId)).toEqual({ written_version: null });
  });
});

describe('an undo that crashes before its item', () => {
  it('counts the restore it made as updated', async () => {
    const passId = await unrendered();
    const id = await start(passId);
    await applyChunk(jobCtxOf(ck.kit), id, null);
    await finish();
    const res = await ck.post(`/broadcasts/${id}/undo`);
    const undoId = ((await res.json()) as { id: string }).id;
    await run(
      ck.kit.env.DB,
      "UPDATE broadcasts SET state = 'sending', started_at = 1 WHERE id = ?",
      [undoId],
    );
    await crashBeforeItem(undoId);
    expect(await input(passId, 'visits')).toBe(0);
    await applyChunk(jobCtxOf(ck.kit), undoId, null);
    expect((await ck.items(undoId))[0]).toMatchObject({ outcome: 'updated' });
  });
});

const rowOf = async (id: string) =>
  (await first<BroadcastRow>(ck.kit.env.DB, 'SELECT * FROM broadcasts WHERE id = ?', [
    id,
  ])) as BroadcastRow;
const intents = (id: string) =>
  all<{ pass_id: string; intent: string | null }>(
    ck.kit.env.DB,
    'SELECT pass_id, intent FROM broadcast_targets WHERE broadcast_id = ? ORDER BY pass_id',
    [id],
  );

describe('keys the stamp must keep', () => {
  it('stamps an input whose name holds a quote and a backslash, so a clear can be undone', async () => {
    const key = 'q"x\\y';
    const passId = await unrendered({ [key]: 'kept' });
    const id = await start(passId);
    const version = (await getPass(ck.kit.env.DB, passId, null))?.version ?? 0;
    await run(
      ck.kit.env.DB,
      'UPDATE broadcast_targets SET intent = ? WHERE broadcast_id = ? AND pass_id = ?',
      [JSON.stringify({ from: { [key]: 'kept' }, to: { [key]: null }, version }), id, passId],
    );
    const without = JSON.stringify({ memberName: 'Alex', visits: 0 });
    await run(
      ck.kit.env.DB,
      'UPDATE passes SET write_ref = ?, personalization = ?, version = version + 1 WHERE id = ?',
      [id, without, passId],
    );
    await settlePending(jobCtxOf(ck.kit), await rowOf(id));
    const { before } = await beforeOf(id);
    expect(before.from[key]).toBe('kept');
    expect(before.to[key]).toBeNull();
  });
});

describe('a stale attempt cannot take over', () => {
  it('setIntent leaves a live intent alone', async () => {
    const passId = await unrendered();
    const id = await start(passId);
    const real = vi.mocked(repo.setIntent).getMockImplementation() as typeof repo.setIntent;
    await real(ck.kit.env.DB, id, passId, '{"live":true}');
    await expect(real(ck.kit.env.DB, id, passId, '{"stale":true}')).rejects.toThrow();
    expect((await intents(id))[0]?.intent).toBe('{"live":true}');
  });

  it('refuses a write once the run has stamped its own, whatever version it read', async () => {
    const passId = await unrendered();
    const id = await start(passId);
    await run(
      ck.kit.env.DB,
      'UPDATE broadcast_targets SET written_version = 1 WHERE broadcast_id = ? AND pass_id = ?',
      [id, passId],
    );
    await applyChunk(jobCtxOf(ck.kit), id, null);
    expect(await input(passId, 'visits')).toBe(0);
    expect((await ck.items(id)).map((i) => i.outcome)).not.toContain('failed');
  });

  it('settles only the pass it stopped on', async () => {
    const a = await unrendered();
    const b = await unrendered();
    const res = await ck.post('/broadcasts', {
      orgId: ck.kit.org.id,
      kind: 'change',
      target: { passIds: [a, b] },
      patch: { visits: { add: 1 } },
    });
    const id = ((await res.json()) as { id: string }).id;
    for (const passId of [a, b])
      await run(
        ck.kit.env.DB,
        'UPDATE broadcast_targets SET intent = ? WHERE broadcast_id = ? AND pass_id = ?',
        [JSON.stringify({ from: { visits: 0 }, to: { visits: 1 }, version: 99 }), id, passId],
      );
    await settlePending(jobCtxOf(ck.kit), await rowOf(id), a);
    const left = await intents(id);
    expect(left.find((r) => r.pass_id === a)?.intent).toBeNull();
    expect(left.find((r) => r.pass_id === b)?.intent).not.toBeNull();
  });

  it('a stale void loses to the live attempt without recording a failure', async () => {
    const pass = await ck.kit.makePass();
    const id = await start(pass.id, { $void: true });
    afterIntent(() => crashBeforeItem(id));
    await applyChunk(jobCtxOf(ck.kit), id, null);
    expect((await getPass(ck.kit.env.DB, pass.id, null))?.status).toBe('voided');
    expect((await ck.items(id)).map((i) => i.outcome)).toEqual(['updated']);
  });
});
