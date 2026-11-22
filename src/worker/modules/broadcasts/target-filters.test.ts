import { describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { createApp } from '../../app.ts';
import { broadcastAuth, broadcastKit } from './test-kit.ts';

const ORIGIN = 'https://wallet.test';

async function setup() {
  const kit = await broadcastKit();
  const auth = await broadcastAuth(kit, ORIGIN);
  const app = createApp({ stores: auth.stores, clock: kit.clock });
  const post = (path: string, body: Record<string, unknown>, mode?: 'live' | 'test') =>
    app.request(
      `${ORIGIN}/api/v1${path}`,
      {
        method: 'POST',
        headers: { ...auth.admin(mode ? { mode } : {}), 'content-type': 'application/json' },
        body: JSON.stringify({ orgId: kit.org.id, ...body }),
      },
      kit.env,
    );
  return { kit, auth, app, post };
}

const CODE = 'BROADCAST_UNSUPPORTED_FILTER';

describe('the mode picks the template release', () => {
  it('previews and creates a message and a change from a Test release alone', async () => {
    const { kit, post } = await setup();
    const tpl = await kit.releasedIn(['test']);
    await kit.makePass({ templateId: tpl.id, mode: 'test', gate: 'A' });
    const target = { templateIds: [tpl.id] };
    const preview = await post('/broadcasts/preview', { target, patch: { gate: 'B' } }, 'test');
    expect(preview.status, await preview.clone().text()).toBe(200);
    expect(await preview.json()).toMatchObject({ targeted: 1 });
    const change = await post(
      '/broadcasts',
      { kind: 'change', send: 'draft', target, patch: { gate: 'B' } },
      'test',
    );
    expect(change.status, await change.clone().text()).toBe(201);
    const message = await post(
      '/broadcasts',
      { kind: 'message', send: 'draft', target, patch: { message: 'Hi' } },
      'test',
    );
    expect(message.status, await message.clone().text()).toBe(201);
  });

  it('keeps Live to the Live release, and a mode with no release is 404', async () => {
    const { kit, post } = await setup();
    const testOnly = await kit.releasedIn(['test']);
    const liveOnly = await kit.releasedIn(['live']);
    const none = await kit.releasedIn([]);
    const message = (id: string, mode: 'live' | 'test') =>
      post(
        '/broadcasts',
        { kind: 'message', send: 'draft', target: { templateIds: [id] }, patch: { message: 'Hi' } },
        mode,
      );
    await expectProblem(await message(testOnly.id, 'live'), 404, 'TEMPLATE_NOT_FOUND');
    await expectProblem(await message(liveOnly.id, 'test'), 404, 'TEMPLATE_NOT_FOUND');
    await expectProblem(await message(none.id, 'test'), 404, 'TEMPLATE_NOT_FOUND');
    expect((await message(liveOnly.id, 'live')).status).toBe(201);
    const change = await post(
      '/broadcasts',
      { kind: 'change', send: 'draft', target: { templateIds: [none.id] }, patch: { gate: 'B' } },
      'live',
    );
    await expectProblem(change, 404, 'TEMPLATE_NOT_FOUND');
  });
});

describe('a target filter the run does not take', () => {
  const fields = {
    status: 'void',
    holderEmail: 'a@example.com',
    externalId: 'ext-1',
    connectionId: 'conn-1',
  };

  it.each(Object.entries(fields))('refuses %s on preview and on create', async (key, value) => {
    const { kit, post } = await setup();
    const target = { templateIds: [kit.messaging.id], [key]: value };
    const preview = await post('/broadcasts/preview', { target, patch: { gate: 'B' } });
    await expectProblem(preview, 422, CODE);
    expect(JSON.stringify(await preview.clone().json())).toContain(`target.${key}`);
    const change = await post('/broadcasts', {
      kind: 'change',
      send: 'draft',
      target,
      patch: { gate: 'B' },
    });
    await expectProblem(change, 422, CODE);
    const problem = (await change.json()) as { detail: string; issues: { path: string }[] };
    expect(problem.issues[0]?.path).toBe(`target.${key}`);
    expect(problem.detail).toContain(key);
    const message = await post('/broadcasts', {
      kind: 'message',
      send: 'draft',
      target,
      patch: { message: 'Hi' },
    });
    await expectProblem(message, 422, CODE);
  });

  it('still takes every filter it supports', async () => {
    const { kit, post } = await setup();
    await kit.makePass({ holderEmail: 'a@example.com', gate: 'A' });
    const target = {
      templateIds: [kit.messaging.id],
      onDevice: false,
      holderState: 'owned',
      q: 'Alex',
      match: [{ input: 'gate', values: ['A'] }],
    };
    const res = await post('/broadcasts/preview', { target, patch: { gate: 'B' } });
    expect(res.status, await res.clone().text()).toBe(200);
  });

  it('refuses it on PATCH, and names every refused field', async () => {
    const { kit, auth, app, post } = await setup();
    const made = await post('/broadcasts', {
      kind: 'message',
      send: 'draft',
      target: { templateIds: [kit.messaging.id] },
      patch: { message: 'Hi' },
    });
    const id = ((await made.json()) as { id: string }).id;
    const patch = await app.request(
      `${ORIGIN}/api/v1/broadcasts/${id}`,
      {
        method: 'PATCH',
        headers: { ...auth.admin(), 'content-type': 'application/json' },
        body: JSON.stringify({
          orgId: kit.org.id,
          kind: 'message',
          send: 'draft',
          target: { templateIds: [kit.messaging.id], status: 'void', holderEmail: 'a@b.co' },
          patch: { message: 'Hi' },
        }),
      },
      kit.env,
    );
    await expectProblem(patch, 422, CODE);
    const problem = (await patch.json()) as { detail: string; issues: { path: string }[] };
    expect(problem.detail).toContain('status, holderEmail');
    expect(problem.issues.map((i) => i.path)).toEqual(['target.status', 'target.holderEmail']);
  });

  it('stays a plain validation error when something else is wrong too', async () => {
    const { kit, post } = await setup();
    const res = await post('/broadcasts', {
      kind: 'message',
      send: 'draft',
      target: { templateIds: [kit.messaging.id], status: 'void' },
      patch: { message: 42 },
    });
    await expectProblem(res, 422, 'VALIDATION');
  });

  it('refuses a stray key inside a match clause or scan, so a clause cannot widen', async () => {
    const { kit, post } = await setup();
    const clause = await post('/broadcasts/preview', {
      target: {
        templateIds: [kit.messaging.id],
        match: [{ input: 'gate', values: ['A'], not: true }],
      },
    });
    await expectProblem(clause, 422, 'VALIDATION');
    const scan = await post('/broadcasts/preview', {
      target: { templateIds: [kit.messaging.id], scan: { noScanDays: 30, eventId: 'e1' } },
    });
    await expectProblem(scan, 422, 'VALIDATION');
  });
});
