import { describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { createApp } from '../../app.ts';
import { first } from '../../platform/db.ts';
import { broadcastAuth, broadcastKit } from './test-kit.ts';

const ORIGIN = 'https://wallet.test';

describe('POST /broadcasts target', () => {
  async function setup() {
    const kit = await broadcastKit();
    const auth = await broadcastAuth(kit, ORIGIN);
    const app = createApp({ stores: auth.stores, clock: kit.clock });
    const send = (body: Record<string, unknown>) =>
      app.request(
        `${ORIGIN}/api/v1/broadcasts`,
        {
          method: 'POST',
          headers: { ...auth.admin(), 'content-type': 'application/json' },
          body: JSON.stringify({ orgId: kit.org.id, send: 'draft', ...body }),
        },
        kit.env,
      );
    const stored = async (id: string) =>
      JSON.parse(
        (
          await first<{ target: string }>(
            kit.env.DB,
            'SELECT target FROM broadcasts WHERE id = ?',
            [id],
          )
        )?.target ?? '{}',
      ) as Record<string, unknown>;
    return { kit, send, stored };
  }

  it('keeps match, and refuses window and sentBy as filters it does not take', async () => {
    const { kit, send, stored } = await setup();
    const target = { templateIds: [kit.messaging.id], match: [{ input: 'gate', values: ['A'] }] };
    const res = await send({ kind: 'message', target, patch: { message: 'Hi' } });
    expect(res.status).toBe(201);
    expect(await stored(((await res.json()) as { id: string }).id)).toEqual(target);
    await expectProblem(
      await send({
        kind: 'message',
        target: { ...target, window: { from: 1, to: 2 }, sentBy: 'rule-1' },
        patch: { message: 'Hi' },
      }),
      422,
      'BROADCAST_UNSUPPORTED_FILTER',
    );
  });

  it('refuses a pass list on a message, with or without templates, by name', async () => {
    const { kit, send } = await setup();
    const patch = { message: 'Hi' };
    // Silently dropping the list would message every pass of the template.
    await expectProblem(
      await send({
        kind: 'message',
        target: { templateIds: [kit.messaging.id], passIds: ['p1'] },
        patch,
      }),
      422,
      'VALIDATION',
    );
    await expectProblem(
      await send({ kind: 'message', target: { passIds: ['p1'] }, patch }),
      422,
      'VALIDATION',
    );
    await expectProblem(
      await send({ kind: 'message', target: { importId: 'i1' }, patch }),
      422,
      'VALIDATION',
    );
  });

  it('never takes the server-only fields from a body', async () => {
    const { kit, send } = await setup();
    const pass = await kit.makePass();
    for (const field of ['revertOf', 'selection', 'retryOf', 'token', 'message'])
      await expectProblem(
        await send({
          kind: 'change',
          target: { passIds: [pass.id], [field]: 'forged' },
          patch: { gate: 'B' },
        }),
        422,
        'BROADCAST_UNSUPPORTED_FILTER',
      );
  });
});
