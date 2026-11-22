import { beforeAll, describe, expect, it } from 'vitest';
import { withoutTrigger } from '../../../../test/helpers/triggers.ts';
import { createApp } from '../../app.ts';
import { run } from '../../platform/db.ts';
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
});
