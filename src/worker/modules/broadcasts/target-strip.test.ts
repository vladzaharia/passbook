import { describe, expect, it } from 'vitest';
import { createApp } from '../../app.ts';
import { first } from '../../platform/db.ts';
import { broadcastAuth, broadcastKit } from './test-kit.ts';

const ORIGIN = 'https://wallet.test';

describe('POST /broadcasts target', () => {
  it('drops window, sentBy and passIds and keeps match', async () => {
    const kit = await broadcastKit();
    const auth = await broadcastAuth(kit, ORIGIN);
    const app = createApp({ stores: auth.stores, clock: kit.clock });
    const res = await app.request(
      `${ORIGIN}/api/v1/broadcasts`,
      {
        method: 'POST',
        headers: { ...auth.admin(), 'content-type': 'application/json' },
        body: JSON.stringify({
          orgId: kit.org.id,
          kind: 'message',
          send: 'draft',
          target: {
            templateIds: [kit.messaging.id],
            match: [{ input: 'gate', values: ['A'] }],
            window: { from: 1, to: 2 },
            sentBy: 'rule-1',
            passIds: ['p1'],
          },
          patch: { message: 'Hi' },
        }),
      },
      kit.env,
    );
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const row = await first<{ target: string }>(
      kit.env.DB,
      'SELECT target FROM broadcasts WHERE id = ?',
      [id],
    );
    expect(JSON.parse(row?.target ?? '{}')).toEqual({
      templateIds: [kit.messaging.id],
      match: [{ input: 'gate', values: ['A'] }],
    });
  });
});
