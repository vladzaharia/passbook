import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { deviceToken, fakeAuth } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import {
  active,
  clearPushes,
  events,
  fenced,
  fetchApple,
  HOUR,
  pendingPushes,
  rowOf,
  seasonKit,
  seasonPass,
  TYPE,
  tick,
} from './event-boundaries-test-fixtures.ts';
import type { Kit } from './pass-test-fixtures.ts';
import { publishPass } from './publish.ts';
import type { Pass } from './repo-map.ts';

const system = { type: 'system', id: null } as const;
let kit: Kit;
beforeAll(async () => {
  kit = await seasonKit();
});
beforeEach(async () => {
  await run(kit.env.DB, 'DELETE FROM pass_boundaries');
});

/** A pass whose event A has just started and been rendered as running. */
async function running(): Promise<Pass> {
  const now = kit.clock.now();
  const pass = await seasonPass(kit, events(['A', now + HOUR, now + 2 * HOUR]));
  await tick(kit);
  kit.clock.set(now + HOUR);
  await tick(kit);
  expect((await rowOf(kit, pass.id))?.rendered_at).toBeGreaterThan(0);
  return pass;
}

const tierEdit = (passId: string, tier: string) =>
  publishPass(jobCtxOf(kit), {
    passId,
    cause: 'admin',
    actor: system,
    mutate: (current) => ({ personalization: { ...current.personalization, tier } }),
  });

describe('serving a timed render', () => {
  it('a publish in the second of the last render is never hidden behind a 304', async () => {
    const pass = await running();
    const render = await fetchApple(kit, pass);
    expect(render.status).toBe(200);
    // Same clock, so the same second as the render's Last-Modified.
    await tierEdit(pass.id, 'Bronze');
    await kit.settle();
    const after = await fetchApple(kit, pass, { 'if-modified-since': render.lastModified ?? '' });
    expect(after.status).toBe(200);
    const tier = (after.json?.generic?.secondaryFields ?? []).find((f) => f.key === 'tier');
    expect(tier?.value).toBe('Bronze');
  });

  it('tags the render weakly, still answers its tag with 304, and HEAD does not render', async () => {
    const pass = await running();
    const render = await fetchApple(kit, pass);
    expect(render.etag).toMatch(/^W\/"/);
    expect((await fetchApple(kit, pass, { 'if-none-match': render.etag ?? '' })).status).toBe(304);
    const app = createApp({ stores: fakeAuth('https://wallet.test').stores });
    const head = await app.request(
      `https://wallet.test/wallet/v1/passes/${TYPE}/${pass.serial}`,
      { method: 'HEAD', headers: { authorization: `ApplePass ${deviceToken(pass)}` } },
      kit.env,
    );
    expect(head.status).toBe(200);
    expect(head.headers.get('etag')).toBe(render.etag);
    // The length is only known once the body is signed; HEAD does not sign it.
    expect(head.headers.get('content-length')).toBeNull();
  });

  it('a sync after a render that changes nothing makes no version and no push', async () => {
    const pass = await running();
    const before = await fenced(kit, pass.id);
    await clearPushes(kit, pass.id);
    const synced = await publishPass(jobCtxOf(kit), {
      passId: pass.id,
      cause: 'connection',
      actor: system,
      mutate: (current) => ({ personalization: current.personalization }),
    });
    await kit.settle();
    expect(synced.changed).toBe(false);
    expect(await fenced(kit, pass.id)).toEqual(before);
    expect(await pendingPushes(kit, pass.id)).toBe(0);
    expect(active((await fetchApple(kit, pass)).json)).toEqual(['A']);
    // A real change still publishes.
    expect((await tierEdit(pass.id, 'Silver')).changed).toBe(true);
  });

  it('an input-only change after a render keeps the artifact hash, so the next render still matches', async () => {
    const pass = await running();
    const hashOf = async () =>
      (
        await kit.env.DB.prepare('SELECT content_hash FROM passes WHERE id = ?')
          .bind(pass.id)
          .first<{ content_hash: string }>()
      )?.content_hash;
    const artifactHash = await hashOf();
    const sync = (note: string) =>
      publishPass(jobCtxOf(kit), {
        passId: pass.id,
        cause: 'connection',
        actor: system,
        // An input no field binds: the build is the same pass.
        mutate: (current) => ({ personalization: { ...current.personalization, note } }),
      });
    const before = await fenced(kit, pass.id);
    expect((await sync('first')).changed).toBe(false);
    expect(await hashOf()).toBe(artifactHash);
    // A's end renders again; a sync after it is still the render, with no version or push.
    kit.clock.set(kit.clock.now() + HOUR + 1);
    await tick(kit);
    await clearPushes(kit, pass.id);
    expect((await sync('second')).changed).toBe(false);
    await kit.settle();
    expect(await hashOf()).toBe(artifactHash);
    expect((await fenced(kit, pass.id))?.versions).toBe(before?.versions);
    expect(await pendingPushes(kit, pass.id)).toBe(0);
  });
});
