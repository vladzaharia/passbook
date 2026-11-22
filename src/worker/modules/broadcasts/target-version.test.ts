import { beforeAll, describe, expect, it } from 'vitest';
import { persistTemplate } from '../../../../test/helpers/index.ts';
import { withoutTrigger } from '../../../../test/helpers/triggers.ts';
import { createApp } from '../../app.ts';
import { all, first, run } from '../../platform/db.ts';
import { runBroadcast } from '../../workflows/broadcast.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { TINY_PNG } from '../passes/pass-test-fixtures.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { startDueBroadcasts } from './start.ts';
import { type BroadcastAuth, type BroadcastKit, broadcastAuth, broadcastKit } from './test-kit.ts';

const ORIGIN = 'https://wallet.test';
let kit: BroadcastKit;
let auth: BroadcastAuth;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  kit = await broadcastKit();
  auth = await broadcastAuth(kit, ORIGIN);
  app = createApp({ stores: auth.stores, clock: kit.clock });
});

const post = (path: string, body: unknown) =>
  app.request(
    `${ORIGIN}/api/v1${path}`,
    {
      method: 'POST',
      headers: { ...auth.admin(), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    kit.env,
  );

const preview = async (target: Record<string, unknown>) =>
  (await (await post('/broadcasts/preview', { orgId: kit.org.id, target })).json()) as {
    targeted: number;
  };

describe('a message to the passes on one version', () => {
  it('reaches those on the version or an equivalent build, never the ones left behind', async () => {
    const on = await kit.makePass();
    const equivalent = await kit.makePass();
    const behind = await kit.makePass();
    await run(
      kit.env.DB,
      "UPDATE passes SET status = 'voided' WHERE id NOT IN (?, ?, ?) AND template_id = ?",
      [on.id, equivalent.id, behind.id, kit.messaging.id],
    );
    const version = on.templateVersion;
    // Two older versions of the template: one with the same build as `version`, one with another.
    await withoutTrigger(kit.env.DB, 'template_versions_insert_immutable', () =>
      withoutTrigger(kit.env.DB, 'template_versions_immutable', async () => {
        for (const [name, key] of [
          ['older-same', 'k-same'],
          ['older-other', 'k-other'],
        ] as const)
          await run(
            kit.env.DB,
            `INSERT INTO template_versions (template_id, version, build_key, manifest, pass_json, assets, report, created_by, created_at)
             SELECT template_id, ?, ?, manifest, pass_json, assets, report, created_by, created_at
             FROM template_versions WHERE template_id = ? AND version = ?`,
            [name, key, kit.messaging.id, version],
          );
        await run(
          kit.env.DB,
          'UPDATE template_versions SET build_key = ? WHERE template_id = ? AND version = ?',
          ['k-same', kit.messaging.id, version],
        );
      }),
    );
    await run(kit.env.DB, 'UPDATE passes SET template_version = ? WHERE id = ?', [
      'older-same',
      equivalent.id,
    ]);
    await run(kit.env.DB, 'UPDATE passes SET template_version = ? WHERE id = ?', [
      'older-other',
      behind.id,
    ]);
    expect(await preview({ templateIds: [kit.messaging.id] })).toMatchObject({ targeted: 3 });
    expect(await preview({ templateIds: [kit.messaging.id], version })).toMatchObject({
      targeted: 2,
    });
  });

  it('is refused for a change, for several templates, and when it is not a message', async () => {
    const body = (extra: Record<string, unknown>, target: Record<string, unknown>) => ({
      orgId: kit.org.id,
      kind: 'message',
      send: 'draft',
      target: { templateIds: [kit.messaging.id], ...target },
      patch: { message: 'Hi' },
      ...extra,
    });
    expect((await post('/broadcasts', body({}, { version: 'v1' }))).status).toBe(201);
    expect(
      (
        await post(
          '/broadcasts',
          body({}, { version: 'v1', templateIds: [kit.messaging.id, kit.plain.id] }),
        )
      ).status,
    ).toBe(422);
    expect(
      (await post('/broadcasts', body({ kind: 'change', patch: { gate: 'A' } }, { version: 'v1' })))
        .status,
    ).toBe(422);
  });

  it('still clears a told pass that moved to another version within the week', async () => {
    const step = {
      do: async (_n: string, a: unknown, b?: unknown) =>
        await ((typeof a === 'function' ? a : b) as () => Promise<unknown>)(),
    } as unknown as Parameters<typeof runBroadcast>[3];
    const exec = async (id: string) => {
      const instance = kit.broadcast.created.at(-1);
      expect(instance?.id).toBe(`broadcast-${id}`);
      await runBroadcast(
        kit.env,
        instance?.id ?? '',
        { broadcastId: id },
        step,
        undefined,
        kit.clock,
      );
      await kit.settle();
    };
    const told = await kit.makePass();
    await run(kit.env.DB, "UPDATE passes SET status = 'voided' WHERE id != ? AND template_id = ?", [
      told.id,
      kit.messaging.id,
    ]);
    const res = await post('/broadcasts', {
      orgId: kit.org.id,
      kind: 'message',
      target: { templateIds: [kit.messaging.id], version: told.templateVersion },
      patch: { message: 'Gym has a new design.' },
      clearAfter: 7 * 86_400_000,
    });
    expect(res.status).toBe(201);
    const sent = (await res.json()) as { id: string };
    await exec(sent.id);
    expect((await getPass(kit.env.DB, told.id, null))?.personalization.message).toBe(
      'Gym has a new design.',
    );
    // The pass moves to a newer, different release before the clear is due.
    const base = await kit.registry.resolve(kit.messaging.id);
    const newer = kit.registry.add({
      id: kit.messaging.id,
      version: 'newer',
      orgId: base.orgId,
      origin: base.origin,
      manifest: base.manifest,
      passJson: { ...base.passJson, description: 'A newer design' },
      assets: { 'icon.png': TINY_PNG },
    });
    await persistTemplate(kit.fx, newer, { registry: kit.registry });
    await run(kit.env.DB, 'UPDATE passes SET template_version = ? WHERE id = ?', [
      'newer',
      told.id,
    ]);
    kit.clock.advance(7 * 86_400_000 + 60_000);
    await startDueBroadcasts(jobCtxOf(kit));
    const follow = await first<{ id: string }>(
      kit.env.DB,
      'SELECT id FROM broadcasts WHERE parent_id = ?',
      [sent.id],
    );
    await exec(follow?.id ?? '');
    expect((await getPass(kit.env.DB, told.id, null))?.personalization.message ?? '').toBe('');
  });

  it('reserves a Tell holders send once per release for the whole organization', async () => {
    const as = (headers: Record<string, string>, text: string) =>
      app.request(
        `${ORIGIN}/api/v1/broadcasts`,
        {
          method: 'POST',
          headers: {
            ...headers,
            'content-type': 'application/json',
            'idempotency-key': 'rollout-tell:rel-1',
          },
          body: JSON.stringify({
            orgId: kit.org.id,
            kind: 'message',
            target: { templateIds: [kit.messaging.id], version: 'v1' },
            patch: { message: text },
          }),
        },
        kit.env,
      );
    // The clock moved a week in the test above: sign in afresh.
    const fresh = await broadcastAuth(kit, ORIGIN);
    const other = await fresh.apiKey({ orgId: kit.org.id, scopes: ['messages:write'] });
    const first = await as(fresh.admin(), 'Tell once per release.');
    expect(first.status).toBe(201);
    const id = ((await first.json()) as { id: string }).id;
    // A second admin (another principal) gets the first send back, not a second message.
    const second = await as(other, 'Tell once per release.');
    expect(second.status).toBe(201);
    expect(((await second.json()) as { id: string }).id).toBe(id);
    const sent = await all<{ id: string }>(
      kit.env.DB,
      "SELECT id FROM broadcasts WHERE org_id = ? AND patch LIKE '%Tell once per release.%'",
      [kit.org.id],
    );
    expect(sent).toEqual([{ id }]);
    // Another text for the same release is refused outright.
    const other2 = await as(other, 'Something else.');
    expect(other2.status).toBe(422);
    expect(await other2.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });
});
