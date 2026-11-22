import { beforeAll, describe, expect, it, vi } from 'vitest';
import { all } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { publishPass } from '../passes/publish.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { applyChunk } from './apply.ts';
import { type ChangeKit, changeKit } from './change-fixtures.ts';
import * as repo from './repo.ts';

vi.mock('./repo.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./repo.ts')>();
  return { ...actual, insertItems: vi.fn(actual.insertItems) };
});

let ck: ChangeKit;
beforeAll(async () => {
  ck = await changeKit();
});

const visits = async (id: string) =>
  (await getPass(ck.kit.env.DB, id, null))?.personalization.visits;
const versions = (id: string) =>
  all(ck.kit.env.DB, 'SELECT version FROM pass_versions WHERE pass_id = ?', [id]);

// `visits` is bound to no field, so writing it stores the input with no pass_versions row.
const unrendered = async () => {
  const pass = await ck.kit.makePass();
  await publishPass(jobCtxOf(ck.kit), {
    passId: pass.id,
    cause: 'admin',
    actor: { type: 'user', id: 'admin-1' },
    notify: false,
    mutate: (p) => ({ personalization: { ...p.personalization, visits: 0 } }),
  });
  return pass.id;
};
const start = async (passId: string) => {
  const res = await ck.post('/broadcasts', {
    orgId: ck.kit.org.id,
    kind: 'change',
    target: { passIds: [passId] },
    patch: { visits: { add: 1 } },
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

describe('a metadata-only write that crashes before its item', () => {
  it('is settled by the pass write_ref, never added twice', async () => {
    const passId = await unrendered();
    const id = await start(passId);
    const stored = (await versions(passId)).length;
    await crashBeforeItem(id);
    expect(await visits(passId)).toBe(1);
    expect((await versions(passId)).length).toBe(stored);
    await applyChunk(jobCtxOf(ck.kit), id, null);
    expect(await visits(passId)).toBe(1);
    const [item] = await ck.items(id);
    expect(item).toMatchObject({ outcome: 'updated' });
    expect(JSON.parse(item?.before ?? '{}')).toMatchObject({
      from: { visits: 0 },
      to: { visits: 1 },
    });
  });

  it('a later unrelated write clears the ref, so it is never taken for the item', async () => {
    const passId = await unrendered();
    const id = await start(passId);
    await crashBeforeItem(id);
    await publishPass(jobCtxOf(ck.kit), {
      passId,
      cause: 'admin',
      actor: { type: 'user', id: 'admin-1' },
      notify: false,
      mutate: (p) => ({ personalization: { ...p.personalization, note: 'x' } }),
    });
    const row = await all<{ write_ref: string | null }>(
      ck.kit.env.DB,
      'SELECT write_ref FROM passes WHERE id = ?',
      [passId],
    );
    expect(row[0]?.write_ref).toBeNull();
  });
});
