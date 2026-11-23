import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import {
  active,
  clearPushes,
  events,
  fenced,
  fetchApple,
  HOUR,
  listed,
  MIN,
  pendingPushes,
  rowOf,
  seasonKit,
  seasonPass,
  tick,
  updatedSince,
} from './event-boundaries-test-fixtures.ts';
import type { Kit } from './pass-test-fixtures.ts';
import { publishPass } from './publish.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await seasonKit();
});
// Each test works its own passes only.
beforeEach(async () => {
  await kit.env.DB.prepare('DELETE FROM pass_boundaries').run();
});

describe('timed renders at event boundaries', () => {
  it('schedules the first boundary after the artifact was built', async () => {
    const now = kit.clock.now();
    const pass = await seasonPass(kit, events(['A', now + 2 * HOUR, now + 3 * HOUR]));
    expect((await rowOf(kit, pass.id))?.due_at).toBe(pass.modifiedAt);
    await tick(kit);
    expect(await rowOf(kit, pass.id)).toMatchObject({ due_at: now + 2 * HOUR, rendered_at: 0 });
  });

  it('flips the active event at the start and the end with no version, a new tag and a push', async () => {
    const now = kit.clock.now();
    const pass = await seasonPass(
      kit,
      events(['A', now + 2 * HOUR, now + 3 * HOUR], ['B', now + 5 * HOUR, now + 6 * HOUR]),
    );
    await kit.device(pass, 'dev-flip', 'b'.repeat(64));
    await tick(kit);
    const before = await fenced(kit, pass.id);
    const built = await fetchApple(kit, pass);
    expect(active(built.json)).toEqual([]);

    kit.clock.set(now + 2 * HOUR);
    await clearPushes(kit, pass.id);
    expect(await tick(kit)).toBe(1);
    expect(await fenced(kit, pass.id)).toEqual(before);
    expect(await pendingPushes(kit, pass.id)).toBe(1);
    const row = await rowOf(kit, pass.id);
    expect(row?.stamp).toBeGreaterThan(Number(before?.revision));
    expect(row?.due_at).toBe(now + 3 * HOUR + 1);

    const started = await fetchApple(kit, pass);
    expect(started.status).toBe(200);
    expect(active(started.json)).toEqual(['A']);
    expect(started.etag).not.toBe(built.etag);
    expect(started.files).toEqual(built.files);
    expect(started.json?.serialNumber).toBe(built.json?.serialNumber);
    expect(started.json?.authenticationToken).toBe(built.json?.authenticationToken);
    // The device's tag from the publish lists the pass again, under the render's tag.
    expect(await updatedSince(kit, 'dev-flip', Number(before?.revision))).toEqual({
      serialNumbers: [pass.serial],
      lastUpdated: String(row?.stamp),
    });
    expect(await updatedSince(kit, 'dev-flip', Number(row?.stamp))).toBeNull();
    expect((await fetchApple(kit, pass, { 'if-none-match': started.etag ?? '' })).status).toBe(304);

    kit.clock.set(now + 3 * HOUR + 1);
    await clearPushes(kit, pass.id);
    await tick(kit);
    const ended = await fetchApple(kit, pass);
    expect(listed(ended.json)).toEqual(['B']);
    expect(active(ended.json)).toEqual([]);
    expect(await fenced(kit, pass.id)).toEqual(before);
    expect(await pendingPushes(kit, pass.id)).toBe(1);
  });

  it('is idempotent: another tick at the same time renders and pushes nothing', async () => {
    const now = kit.clock.now();
    const pass = await seasonPass(kit, events(['A', now + HOUR, now + 2 * HOUR]));
    await tick(kit);
    kit.clock.set(now + HOUR);
    await tick(kit);
    const row = await rowOf(kit, pass.id);
    await clearPushes(kit, pass.id);
    expect(await tick(kit)).toBe(0);
    await kit.env.DB.prepare('UPDATE pass_boundaries SET due_at = ? WHERE pass_id = ?')
      .bind(kit.clock.now(), pass.id)
      .run();
    expect(await tick(kit)).toBe(1);
    expect(await pendingPushes(kit, pass.id)).toBe(0);
    expect((await rowOf(kit, pass.id))?.stamp).toBe(row?.stamp);
  });

  it("ends an event without an end after the template's fallbackMinutes", async () => {
    const now = kit.clock.now();
    const pass = await seasonPass(kit, events(['Open', now + HOUR]));
    await tick(kit);
    kit.clock.set(now + HOUR);
    await tick(kit);
    expect((await rowOf(kit, pass.id))?.due_at).toBe(now + HOUR + 90 * MIN + 1);
    kit.clock.set(now + HOUR + 90 * MIN + 1);
    await tick(kit);
    expect(listed((await fetchApple(kit, pass)).json)).toEqual([]);
    // Nothing left to change: the row stays only to serve the render.
    expect((await rowOf(kit, pass.id))?.due_at).toBeNull();
  });

  it("keeps the version's change message and makes no alert or notify use", async () => {
    const now = kit.clock.now();
    const pass = await seasonPass(kit, events(['A', now + HOUR, now + 2 * HOUR]));
    await publishPass(jobCtxOf(kit), {
      passId: pass.id,
      cause: 'admin',
      actor: { type: 'system', id: null },
      notify: true,
      mutate: (current) => ({ personalization: { ...current.personalization, tier: 'Platinum' } }),
    });
    await kit.settle();
    await tick(kit);
    const before = await fenced(kit, pass.id);
    kit.clock.set(now + HOUR);
    await tick(kit);
    const fetched = await fetchApple(kit, pass);
    const tier = (fetched.json?.generic?.secondaryFields ?? []).find((f) => f.key === 'tier');
    expect(tier).toMatchObject({ value: 'Platinum', changeMessage: 'Tier: %@' });
    expect(active(fetched.json)).toEqual(['A']);
    // No version, so no notifying update is counted against the pass's daily budget.
    expect(await fenced(kit, pass.id)).toEqual(before);
  });

  it('starts over from a new artifact: the trigger resets the row and the render', async () => {
    const now = kit.clock.now();
    const pass = await seasonPass(kit, events(['A', now + HOUR, now + 2 * HOUR]));
    await tick(kit);
    kit.clock.set(now + HOUR);
    await tick(kit);
    expect((await rowOf(kit, pass.id))?.rendered_at).toBeGreaterThan(0);
    const edited = await publishPass(jobCtxOf(kit), {
      passId: pass.id,
      cause: 'admin',
      actor: { type: 'system', id: null },
      mutate: (current) => ({ personalization: { ...current.personalization, tier: 'Silver' } }),
    });
    await kit.settle();
    expect(await rowOf(kit, pass.id)).toMatchObject({
      due_at: edited.pass.modifiedAt,
      rendered_at: 0,
      stamp: 0,
      render: null,
    });
    // The new artifact was built at the boundary's side it is on: nothing to render.
    expect(active((await fetchApple(kit, pass)).json)).toEqual(['A']);
    await clearPushes(kit, pass.id);
    await tick(kit);
    expect(await rowOf(kit, pass.id)).toMatchObject({ due_at: now + 2 * HOUR + 1, rendered_at: 0 });
    expect(await pendingPushes(kit, pass.id)).toBe(0);
  });
});
