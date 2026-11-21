import { describe, expect, it } from 'vitest';
import { createApp } from '../../app.ts';
import { first, run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { applyChunk } from './apply.ts';
import { insertBroadcastStmt } from './repo.ts';
import { broadcastAuth, broadcastKit } from './test-kit.ts';

const ORIGIN = 'https://wallet.test';

describe('stored targets that stop parsing', () => {
  it('a time zone that left the database fails the run with a stable code', async () => {
    const kit = await broadcastKit();
    const id = kit.fx.ids.id();
    await insertBroadcastStmt(kit.env.DB, {
      id,
      orgId: kit.org.id,
      mode: 'live',
      kind: 'message',
      name: 'Zone',
      state: 'scheduled',
      target: {
        templateIds: [kit.messaging.id],
        match: [{ input: 'gate', from: '2026-01-01', timeZone: 'Mars/Base' }],
      },
      patch: { message: 'Hi' },
      notify: true,
      at: kit.clock.now(),
      clearAfter: null,
      actor: { type: 'system', id: null },
      now: kit.clock.now(),
    }).run();
    await run(kit.env.DB, "UPDATE broadcasts SET state = 'sending' WHERE id = ?", [id]);
    expect(await applyChunk(jobCtxOf(kit), id, null)).toEqual({ nextCursor: null });
    expect(
      await first(kit.env.DB, 'SELECT state, error_code FROM broadcasts WHERE id = ?', [id]),
    ).toEqual({ state: 'failed', error_code: 'BROADCAST_TARGET_INVALID' });
  });
});

describe('match input checks', () => {
  it('refuses a match on an input no targeted template defines', async () => {
    const kit = await broadcastKit();
    const auth = await broadcastAuth(kit, ORIGIN);
    const app = createApp({ stores: auth.stores, clock: kit.clock });
    const post = (match: unknown) =>
      app.request(
        `${ORIGIN}/api/v1/broadcasts`,
        {
          method: 'POST',
          headers: { ...auth.admin(), 'content-type': 'application/json' },
          body: JSON.stringify({
            orgId: kit.org.id,
            kind: 'message',
            send: 'draft',
            target: { templateIds: [kit.messaging.id], match },
            patch: { message: 'Hi' },
          }),
        },
        kit.env,
      );
    const bad = await post([{ input: 'sailng', values: ['A'] }]);
    expect(bad.status).toBe(422);
    expect(await bad.json()).toMatchObject({ code: 'BROADCAST_UNKNOWN_INPUT' });
    expect((await post([{ input: 'gate', values: ['A'] }])).status).toBe(201);
  });

  it('GET /passes reads a match without a template when its input is unambiguous', async () => {
    const kit = await broadcastKit();
    const auth = await broadcastAuth(kit, ORIGIN);
    const app = createApp({ stores: auth.stores, clock: kit.clock });
    const match = encodeURIComponent(JSON.stringify([{ input: 'gate', values: ['A'] }]));
    const get = (query: string) =>
      app.request(`${ORIGIN}/api/v1/passes?${query}`, { headers: auth.admin() }, kit.env);
    expect((await get(`orgId=${kit.org.id}&match=${match}`)).status).toBe(200);
    expect(
      (await get(`orgId=${kit.org.id}&templateId=${kit.messaging.id}&match=${match}`)).status,
    ).toBe(200);
  });
});
