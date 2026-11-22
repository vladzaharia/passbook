import { describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { createApp } from '../../app.ts';
import { run } from '../../platform/db.ts';
import { broadcastAuth, broadcastKit } from './test-kit.ts';

const ORIGIN = 'https://wallet.test';

async function setup() {
  const kit = await broadcastKit();
  const auth = await broadcastAuth(kit, ORIGIN);
  const app = createApp({ stores: auth.stores, clock: kit.clock });
  const post = (path: string, body: Record<string, unknown>, mode: 'live' | 'test' = 'live') =>
    app.request(
      `${ORIGIN}/api/v1${path}`,
      {
        method: 'POST',
        headers: { ...auth.admin({ mode }), 'content-type': 'application/json' },
        body: JSON.stringify({ orgId: kit.org.id, ...body }),
      },
      kit.env,
    );
  const create = (
    kind: string,
    templateId: string,
    patch: Record<string, unknown>,
    mode?: 'live' | 'test',
  ) =>
    post(
      '/broadcasts',
      { kind, send: 'draft', target: { templateIds: [templateId] }, patch },
      mode,
    );
  return { kit, post, create };
}

describe('the version a broadcast reads', () => {
  it("is the mode's own release: Live on v1, Test on v2", async () => {
    const { kit, create } = await setup();
    const tpl = await kit.versioned();
    // v2 adds the input gate2 and a message field; v1 has neither.
    expect((await create('change', tpl.id, { gate2: { set: 'A' } }, 'test')).status).toBe(201);
    await expectProblem(
      await create('change', tpl.id, { gate2: { set: 'A' } }, 'live'),
      422,
      'BROADCAST_UNKNOWN_INPUT',
    );
    expect((await create('message', tpl.id, { message: 'Hi' }, 'test')).status).toBe(201);
    await expectProblem(
      await create('message', tpl.id, { message: 'Hi' }, 'live'),
      422,
      'MESSAGING_UNSUPPORTED',
    );
  });
});

describe('a template with no current release', () => {
  it('names the template in the 404 when no active pass holds it', async () => {
    const { kit, create, post } = await setup();
    const none = await kit.releasedIn([]);
    const res = await create('message', none.id, { message: 'Hi' });
    await expectProblem(res, 404, 'TEMPLATE_NOT_FOUND');
    expect(((await res.clone().json()) as { detail: string }).detail).toContain(none.id);
    // Preview refuses it the same way.
    await expectProblem(
      await post('/broadcasts/preview', { target: { templateIds: [none.id] } }),
      404,
      'TEMPLATE_NOT_FOUND',
    );
  });

  it('keeps an archived template working for its active passes', async () => {
    const { kit, create, post } = await setup();
    const tpl = await kit.releasedIn(['live']);
    await kit.makePass({ templateId: tpl.id, gate: 'A' });
    await run(kit.env.DB, "UPDATE templates SET status = 'archived' WHERE id = ?", [tpl.id]);
    expect((await create('message', tpl.id, { message: 'Hi' })).status).toBe(201);
    expect((await create('change', tpl.id, { gate: { set: 'B' } })).status).toBe(201);
    expect((await create('change', tpl.id, { $void: true })).status).toBe(201);
    const preview = await post('/broadcasts/preview', { target: { templateIds: [tpl.id] } });
    expect(preview.status, await preview.clone().text()).toBe(200);
    // Moving to the latest design needs a release to move to.
    await expectProblem(
      await create('change', tpl.id, { $design: true }),
      422,
      'BROADCAST_NO_RELEASE',
    );
  });

  it('keeps a template whose release stopped being current, for its active passes', async () => {
    const { kit, create } = await setup();
    const tpl = await kit.releasedIn(['live']);
    await kit.makePass({ templateId: tpl.id, gate: 'A' });
    // A release is immutable; an adapter revision it was approved under going stale is simulated.
    await run(kit.env.DB, 'DROP TRIGGER template_releases_immutable');
    await run(
      kit.env.DB,
      'UPDATE template_releases SET adapter_revision = adapter_revision + 1 WHERE template_id = ?',
      [tpl.id],
    );
    expect((await create('change', tpl.id, { gate: { set: 'B' } })).status).toBe(201);
    expect((await create('message', tpl.id, { message: 'Hi' })).status).toBe(201);
  });

  it('reads the newest version by its own creation, not the newest pass, and skips removed passes', async () => {
    const { kit, create } = await setup();
    const tpl = await kit.versioned();
    // The older pass holds v2 (the newer version, with gate2); the newest pass was rolled back to v1.
    const a = await kit.makePass({ templateId: tpl.id, mode: 'test', gate: 'A' });
    kit.clock.advance(1000);
    const b = await kit.makePass({ templateId: tpl.id, mode: 'test', gate: 'B' });
    await run(kit.env.DB, "UPDATE passes SET template_version = 'v1' WHERE id = ?", [b.id]);
    await run(kit.env.DB, "UPDATE templates SET status = 'archived' WHERE id = ?", [tpl.id]);
    expect((await create('change', tpl.id, { gate2: { set: 'X' } }, 'test')).status).toBe(201);
    // Removed passes do not count: with the only v2 pass removed, v1 is what is held.
    await run(kit.env.DB, 'UPDATE passes SET removed_at = 1 WHERE id = ?', [a.id]);
    await expectProblem(
      await create('change', tpl.id, { gate2: { set: 'X' } }, 'test'),
      422,
      'BROADCAST_UNKNOWN_INPUT',
    );
    await run(kit.env.DB, 'UPDATE passes SET removed_at = 1 WHERE id = ?', [b.id]);
    await expectProblem(
      await create('change', tpl.id, { gate: { set: 'X' } }, 'test'),
      404,
      'TEMPLATE_NOT_FOUND',
    );
  });
});
