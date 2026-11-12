import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app.ts';
import { first, run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { type Kit, setupKit } from './pass-test-fixtures.ts';
import { publishPass } from './publish.ts';
import { removePass, restorePass } from './remove.ts';
import { getPass } from './repo-read-pass.ts';
import {
  claimRemoval,
  claimRestore,
  getPassLifecycle,
  getRemoval,
  reinstateRemoval,
  releaseRemoval,
  removalVersion,
} from './repo-remove.ts';
import { setupTenantTestAuth, type TenantTestAuth } from './tenant-test-fixtures.ts';

const ORIGIN = 'https://wallet.test';
let kit: Kit;
let auth: TenantTestAuth;
let app: ReturnType<typeof createApp>;
const actor = { type: 'user' as const, id: null };

beforeAll(async () => {
  kit = await setupKit();
  auth = await setupTenantTestAuth(kit);
  app = createApp({ stores: auth.stores, clock: kit.clock });
});

const versions = async (id: string) =>
  (
    await first<{ n: number }>(
      kit.env.DB,
      'SELECT count(*) AS n FROM pass_versions WHERE pass_id = ?',
      [id],
    )
  )?.n;

describe('remove after a crash between the claim and the publish', () => {
  it('publishes the removal version on the next remove, once', async () => {
    const pass = await kit.pass();
    const now = kit.clock.now();
    const lifecycle = await getPassLifecycle(kit.env.DB, pass);
    if (!lifecycle) throw new Error('Pass lifecycle missing');
    expect(
      await claimRemoval(
        kit.ctx,
        pass.id,
        { at: now, message: 'Moved', priorStatus: pass.status },
        { pass, generation: lifecycle.generation, now },
      ),
    ).not.toBeNull();
    expect(await removalVersion(kit.env.DB, pass.id)).toBeNull();
    const out = await removePass(jobCtxOf(kit), actor, pass.id, {}, null);
    expect(out.status).toBe('voided');
    expect(await removalVersion(kit.env.DB, pass.id)).toBe(2);
    // A third remove changes nothing.
    await removePass(jobCtxOf(kit), actor, pass.id, {}, null);
    expect(await versions(pass.id)).toBe(2);
  });
});

it.each([
  ['version', 'UPDATE passes SET version = version + 1 WHERE id = ?'],
  ['status', "UPDATE passes SET status = 'voided' WHERE id = ?"],
  [
    'object',
    "UPDATE passes SET object_key = object_key || '-changed', version = version + 1 WHERE id = ?",
  ],
  ['holder generation', 'UPDATE passes SET link_generation = link_generation + 1 WHERE id = ?'],
])('rejects recovery after the captured %s changes without touching R2', async (_label, sql) => {
  const pass = await kit.pass();
  const now = kit.clock.now();
  const lifecycle = await getPassLifecycle(kit.env.DB, pass);
  if (!lifecycle) throw new Error('Pass lifecycle missing');
  const generation = await claimRemoval(
    kit.ctx,
    pass.id,
    { at: now, message: 'Moved', priorStatus: pass.status },
    { pass, generation: lifecycle.generation, now },
  );
  if (generation === null) throw new Error('Removal was not claimed');
  await run(kit.env.DB, sql, [pass.id]);
  const before = await getPass(kit.env.DB, pass.id);
  const puts = vi.spyOn(kit.env.BUCKET, 'put');
  const deletes = vi.spyOn(kit.env.BUCKET, 'delete');
  try {
    await expect(removePass(jobCtxOf(kit), actor, pass.id, {}, null)).rejects.toMatchObject({
      code: 'PASS_CONFLICT',
    });
    expect(puts).not.toHaveBeenCalled();
    expect(deletes).not.toHaveBeenCalled();
    expect(await getPass(kit.env.DB, pass.id)).toEqual(before);
    expect((await getRemoval(kit.env.DB, pass.id))?.generation).toBe(generation);
  } finally {
    puts.mockRestore();
    deletes.mockRestore();
  }
});

it('fails closed for an unprovable legacy removal but still permits restore and a fresh removal', async () => {
  const pass = await kit.pass();
  await removePass(jobCtxOf(kit), actor, pass.id, { message: 'Legacy' }, null);
  await run(
    kit.env.DB,
    `UPDATE passes SET lifecycle_generation = 0, removal_published_generation = NULL,
       removal_claim_version = NULL, removal_claim_status = NULL, removal_claim_object_key = NULL,
       removal_claim_link_generation = NULL WHERE id = ?`,
    [pass.id],
  );
  const before = await getPass(kit.env.DB, pass.id);
  const puts = vi.spyOn(kit.env.BUCKET, 'put');
  const deletes = vi.spyOn(kit.env.BUCKET, 'delete');
  try {
    await expect(removePass(jobCtxOf(kit), actor, pass.id, {}, null)).rejects.toMatchObject({
      code: 'PASS_CONFLICT',
      message:
        'This removal predates recovery tracking. Restore the pass before removing it again.',
    });
    expect(puts).not.toHaveBeenCalled();
    expect(deletes).not.toHaveBeenCalled();
    expect(await getPass(kit.env.DB, pass.id)).toEqual(before);
  } finally {
    puts.mockRestore();
    deletes.mockRestore();
  }
  expect((await restorePass(jobCtxOf(kit), actor, pass.id, null)).status).toBe('active');
  expect((await removePass(jobCtxOf(kit), actor, pass.id, {}, null)).status).toBe('voided');
});

it('rejects same-millisecond removal ABA before publishing and cannot roll back the new claim', async () => {
  const pass = await kit.pass();
  const now = kit.clock.now();
  const initial = await getPassLifecycle(kit.env.DB, pass);
  if (!initial) throw new Error('Pass lifecycle missing');
  const input = { at: now, message: 'Same', priorStatus: pass.status };
  const firstGeneration = await claimRemoval(kit.ctx, pass.id, input, {
    pass,
    generation: initial.generation,
    now,
  });
  if (firstGeneration === null) throw new Error('Removal was not claimed');
  const firstPass = await getPass(kit.env.DB, pass.id);
  const firstRemoval = await getRemoval(kit.env.DB, pass.id);
  if (!firstPass || !firstRemoval) throw new Error('Removal missing');
  const restoreGeneration = await claimRestore(kit.ctx, pass.id, firstRemoval, {
    pass: firstPass,
    generation: firstGeneration,
    now,
  });
  if (restoreGeneration === null) throw new Error('Restore was not claimed');
  const restored = await getPass(kit.env.DB, pass.id);
  if (!restored) throw new Error('Pass missing');
  const secondGeneration = await claimRemoval(kit.ctx, pass.id, input, {
    pass: restored,
    generation: restoreGeneration,
    now,
  });
  if (secondGeneration === null) throw new Error('Second removal was not claimed');
  expect(secondGeneration).toBeGreaterThan(firstGeneration);
  const current = await getRemoval(kit.env.DB, pass.id);
  expect(current).toMatchObject({
    at: firstRemoval.at,
    message: firstRemoval.message,
    rawPriorStatus: firstRemoval.rawPriorStatus,
    generation: secondGeneration,
  });
  await releaseRemoval(kit.env.DB, pass.id, {
    pass,
    state: input,
    generation: firstGeneration,
  });
  expect((await getRemoval(kit.env.DB, pass.id))?.generation).toBe(secondGeneration);
  const puts = vi.spyOn(kit.env.BUCKET, 'put');
  const deletes = vi.spyOn(kit.env.BUCKET, 'delete');
  try {
    await expect(
      publishPass(jobCtxOf(kit), {
        passId: pass.id,
        orgScope: null,
        cause: 'admin',
        source: 'remove',
        actor,
        force: true,
        expectedPass: firstPass,
        expectedRemoval: {
          at: firstRemoval.at,
          message: firstRemoval.message,
          priorStatus: firstRemoval.rawPriorStatus,
          generation: firstGeneration,
        },
        mutate: () => ({ status: 'voided' }),
      }),
    ).rejects.toMatchObject({ code: 'PASS_CONFLICT' });
    expect(puts).not.toHaveBeenCalled();
    expect(deletes).not.toHaveBeenCalled();
  } finally {
    puts.mockRestore();
    deletes.mockRestore();
  }
  const secondPass = await getPass(kit.env.DB, pass.id);
  const secondRemoval = await getRemoval(kit.env.DB, pass.id);
  if (!secondPass || !secondRemoval) throw new Error('Second removal missing');
  const secondRestore = await claimRestore(kit.ctx, pass.id, secondRemoval, {
    pass: secondPass,
    generation: secondGeneration,
    now,
  });
  if (secondRestore === null) throw new Error('Second restore was not claimed');
  await reinstateRemoval(kit.env.DB, pass.id, firstRemoval, {
    pass: firstPass,
    generation: restoreGeneration,
  });
  expect(await getRemoval(kit.env.DB, pass.id)).toBeNull();
  const afterRestore = await getPass(kit.env.DB, pass.id);
  if (!afterRestore) throw new Error('Pass missing');
  expect((await getPassLifecycle(kit.env.DB, afterRestore))?.generation).toBe(secondRestore);
});

it('does not report a previous removal version for a new unpublished claim', async () => {
  const pass = await kit.pass();
  await removePass(jobCtxOf(kit), actor, pass.id, { message: 'Old' }, null);
  const oldVersion = await removalVersion(kit.env.DB, pass.id);
  const removed = await getPass(kit.env.DB, pass.id);
  const first = await getRemoval(kit.env.DB, pass.id);
  if (!removed || !first || oldVersion === null) throw new Error('Removal missing');
  const now = kit.clock.now();
  const restoreGeneration = await claimRestore(kit.ctx, pass.id, first, {
    pass: removed,
    generation: first.generation,
    now,
  });
  if (restoreGeneration === null) throw new Error('Restore was not claimed');
  const restored = await getPass(kit.env.DB, pass.id);
  if (!restored) throw new Error('Pass missing');
  const generation = await claimRemoval(
    kit.ctx,
    pass.id,
    { at: first.at, message: 'New', priorStatus: restored.status },
    { pass: restored, generation: restoreGeneration, now },
  );
  if (generation === null) throw new Error('Second removal was not claimed');
  expect(await removalVersion(kit.env.DB, pass.id)).toBeNull();
  expect((await getRemoval(kit.env.DB, pass.id))?.generation).toBe(generation);
  const recovered = await removePass(jobCtxOf(kit), actor, pass.id, {}, null);
  expect(recovered.version).toBe(oldVersion + 1);
  expect(await removalVersion(kit.env.DB, pass.id)).toBe(recovered.version);
});

it('retains a proven removal through a re-sign and repeated remove is a no-op', async () => {
  const pass = await kit.pass();
  await removePass(jobCtxOf(kit), actor, pass.id, { message: 'Done' }, null);
  const removal = await getRemoval(kit.env.DB, pass.id);
  if (!removal) throw new Error('Removal missing');
  expect(removal.publishedGeneration).toBe(removal.generation);
  const provenVersion = await removalVersion(kit.env.DB, pass.id);
  await publishPass(jobCtxOf(kit), {
    passId: pass.id,
    orgScope: null,
    cause: 'resign',
    actor,
    force: true,
  });
  const resigned = await getPass(kit.env.DB, pass.id);
  if (!resigned) throw new Error('Pass missing');
  expect((await getRemoval(kit.env.DB, pass.id))?.publishedGeneration).toBe(removal.generation);
  expect(await removalVersion(kit.env.DB, pass.id)).toBe(provenVersion);
  expect((await removePass(jobCtxOf(kit), actor, pass.id, {}, null)).version).toBe(
    resigned.version,
  );
});

it('does not mint a removal publication marker from a non-removal publish', async () => {
  const pass = await kit.pass();
  const now = kit.clock.now();
  const lifecycle = await getPassLifecycle(kit.env.DB, pass);
  if (!lifecycle) throw new Error('Pass lifecycle missing');
  const generation = await claimRemoval(
    kit.ctx,
    pass.id,
    { at: now, message: null, priorStatus: pass.status },
    { pass, generation: lifecycle.generation, now },
  );
  if (generation === null) throw new Error('Removal was not claimed');
  await publishPass(jobCtxOf(kit), {
    passId: pass.id,
    orgScope: null,
    cause: 'resign',
    actor,
    force: true,
  });
  const removal = await getRemoval(kit.env.DB, pass.id);
  expect(removal?.generation).toBe(generation);
  expect(removal?.publishedGeneration).toBeNull();
  expect(await removalVersion(kit.env.DB, pass.id)).toBeNull();
  await expect(removePass(jobCtxOf(kit), actor, pass.id, {}, null)).rejects.toMatchObject({
    code: 'PASS_CONFLICT',
  });
});

describe('restore claims the removal', () => {
  it('only one of two concurrent restores publishes', async () => {
    const pass = await kit.pass();
    await removePass(jobCtxOf(kit), actor, pass.id, {}, null);
    const before = await versions(pass.id);
    await Promise.all([
      restorePass(jobCtxOf(kit), actor, pass.id, null),
      restorePass(jobCtxOf(kit), actor, pass.id, null),
    ]);
    expect(await versions(pass.id)).toBe((before ?? 0) + 1);
    expect((await getPass(kit.env.DB, pass.id))?.removedAt).toBeNull();
  });

  it('claimRestore matches the removal it read; a newer removal survives', async () => {
    const pass = await kit.pass();
    await removePass(jobCtxOf(kit), actor, pass.id, {}, null);
    const first = await getRemoval(kit.env.DB, pass.id);
    const removed = await getPass(kit.env.DB, pass.id);
    if (!first || !removed) throw new Error('Removal missing');
    const generation = await claimRestore(kit.ctx, pass.id, first, {
      pass: removed,
      generation: first.generation,
      now: kit.clock.now(),
    });
    expect(generation).not.toBeNull();
    if (generation === null) throw new Error('Restore was not claimed');
    const restored = await getPass(kit.env.DB, pass.id);
    if (!restored) throw new Error('Pass missing');
    const lifecycle = await getPassLifecycle(kit.env.DB, restored);
    if (!lifecycle) throw new Error('Pass lifecycle missing');
    const later = first.at + 1000;
    expect(
      await claimRemoval(
        kit.ctx,
        pass.id,
        { at: later, message: null, priorStatus: restored.status },
        { pass: restored, generation: lifecycle.generation, now: kit.clock.now() },
      ),
    ).not.toBeNull();
    expect(
      await claimRestore(kit.ctx, pass.id, first, {
        pass: removed,
        generation: first.generation,
        now: kit.clock.now(),
      }),
    ).toBeNull();
    await reinstateRemoval(kit.env.DB, pass.id, first, { pass: removed, generation });
    expect((await getRemoval(kit.env.DB, pass.id))?.at).toBe(later);
  });

  it('a failed restore puts the removal back', async () => {
    const pass = await kit.pass();
    await removePass(jobCtxOf(kit), actor, pass.id, { message: 'Bye' }, null);
    await run(
      kit.env.DB,
      "CREATE TRIGGER versions_block BEFORE INSERT ON pass_versions BEGIN SELECT RAISE(ABORT, 'blocked'); END",
    );
    try {
      await expect(restorePass(jobCtxOf(kit), actor, pass.id, null)).rejects.toThrow();
    } finally {
      await run(kit.env.DB, 'DROP TRIGGER versions_block');
    }
    const removal = await getRemoval(kit.env.DB, pass.id);
    const current = await getPass(kit.env.DB, pass.id);
    if (!removal || !current) throw new Error('Removal missing');
    expect(removal.message).toBe('Bye');
    expect(removal.publishedGeneration).toBeNull();
    expect(removal.claimVersion).toBe(current.version);
    await removePass(jobCtxOf(kit), actor, pass.id, {}, null);
    const recovered = await getRemoval(kit.env.DB, pass.id);
    expect(recovered?.publishedGeneration).toBe(recovered?.generation);
  });

  it('the app route restores once', async () => {
    const pass = await kit.pass();
    await removePass(jobCtxOf(kit), actor, pass.id, {}, null);
    const res = await app.request(
      `${ORIGIN}/api/v1/passes/${pass.id}/restore`,
      {
        method: 'POST',
        headers: { ...auth.admin(), 'content-type': 'application/json' },
        body: '{}',
      },
      kit.env,
    );
    expect(res.status).toBe(200);
  });
});

describe('removal progress after the ledger is purged', () => {
  it('reads the removal version from the version row', async () => {
    const pass = await kit.pass();
    await removePass(jobCtxOf(kit), actor, pass.id, {}, null);
    await run(kit.env.DB, "DELETE FROM pass_events WHERE pass_id = ? AND kind = 'pass.removed'", [
      pass.id,
    ]);
    const res = await app.request(
      `${ORIGIN}/api/v1/passes/${pass.id}/devices`,
      { headers: auth.admin() },
      kit.env,
    );
    const body = (await res.json()) as { removal: { version: number } | null };
    expect(body.removal?.version).toBe(2);
  });
});

describe('versions carry their source', () => {
  it('lists remove and restore on the detail', async () => {
    const pass = await kit.pass();
    await removePass(jobCtxOf(kit), actor, pass.id, {}, null);
    await restorePass(jobCtxOf(kit), actor, pass.id, null);
    const res = await app.request(
      `${ORIGIN}/api/v1/passes/${pass.id}`,
      { headers: auth.admin() },
      kit.env,
    );
    const body = (await res.json()) as { versions: { version: number; source: string | null }[] };
    expect(body.versions.map((v) => [v.version, v.source]).sort()).toEqual([
      [1, null],
      [2, 'remove'],
      [3, 'restore'],
    ]);
  });
});

describe('the list filters removed passes', () => {
  it('status=removed lists them and status=voided leaves them out', async () => {
    const removed = await kit.pass();
    const voided = await kit.pass();
    await removePass(jobCtxOf(kit), actor, removed.id, {}, null);
    const voidResponse = await app.request(
      `${ORIGIN}/api/v1/passes/${voided.id}/void`,
      {
        method: 'POST',
        headers: { ...auth.admin(), 'content-type': 'application/json' },
        body: '{}',
      },
      kit.env,
    );
    expect(voidResponse.status).toBe(200);
    const ids = async (status: string) =>
      (
        (await (
          await app.request(
            `${ORIGIN}/api/v1/passes?orgId=${encodeURIComponent(kit.org.id)}&limit=200&status=${status}`,
            { headers: auth.admin() },
            kit.env,
          )
        ).json()) as { items: { id: string }[] }
      ).items.map((p) => p.id);
    const gone = await ids('removed');
    expect(gone).toContain(removed.id);
    expect(gone).not.toContain(voided.id);
    const v = await ids('voided');
    expect(v).toContain(voided.id);
    expect(v).not.toContain(removed.id);
  });
});
