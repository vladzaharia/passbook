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
    // The preview follows the same rule.
    const previewOf = (target: Record<string, unknown>) =>
      post('/broadcasts/preview', { orgId: kit.org.id, target });
    expect((await previewOf({ templateIds: [kit.messaging.id], version: 'v1' })).status).toBe(200);
    expect(
      (await previewOf({ templateIds: [kit.messaging.id, kit.plain.id], version: 'v1' })).status,
    ).toBe(422);
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

  describe('Tell holders reservation', () => {
    const post2 = (headers: Record<string, string>, key: string, body: Record<string, unknown>) =>
      app.request(
        `${ORIGIN}/api/v1/broadcasts`,
        {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json', 'idempotency-key': key },
          body: JSON.stringify({ orgId: kit.org.id, ...body }),
        },
        kit.env,
      );
    let version = 'v1';
    beforeAll(async () => {
      version = (await kit.makePass()).templateVersion;
    });
    const tell = (text: string, extra: Record<string, unknown> = {}) => ({
      kind: 'message',
      target: { templateIds: [kit.messaging.id], version },
      patch: { message: text },
      ...extra,
    });
    const releaseId = async () =>
      (
        await first<{ id: string }>(
          kit.env.DB,
          "SELECT id FROM template_releases WHERE template_id = ? AND mode = 'live' ORDER BY generation DESC",
          [kit.messaging.id],
        )
      )?.id ?? '';

    it('lets only the claimant replay; another principal gets 409 and no body', async () => {
      await kit.makePass();
      // The clock moved a week in the tests above: sign in afresh.
      const fresh = await broadcastAuth(kit, ORIGIN);
      const other = await fresh.apiKey({ orgId: kit.org.id, scopes: ['messages:write'] });
      const key = `rollout-tell:${await releaseId()}`;
      const first = await post2(fresh.admin(), key, tell('Tell once per release.'));
      expect(first.status).toBe(201);
      const id = ((await first.json()) as { id: string }).id;
      // The claimant's retry is a normal replay.
      const again = await post2(fresh.admin(), key, tell('Tell once per release.'));
      expect(again.status).toBe(201);
      expect(((await again.json()) as { id: string }).id).toBe(id);
      // Anyone else is told it was sent, with nothing of the first response.
      const second = await post2(other, key, tell('Tell once per release.'));
      expect(second.status).toBe(409);
      const problem = (await second.json()) as { code: string };
      expect(problem).toMatchObject({ code: 'TELL_ALREADY_SENT' });
      expect(JSON.stringify(problem)).not.toContain(id);
      const sent = await all<{ id: string }>(
        kit.env.DB,
        "SELECT id FROM broadcasts WHERE org_id = ? AND patch LIKE '%Tell once per release.%'",
        [kit.org.id],
      );
      expect(sent).toEqual([{ id }]);
    });

    it('does not honour a claimant row it did not write', async () => {
      await kit.makePass();
      const fresh = await broadcastAuth(kit, ORIGIN);
      const other = await fresh.apiKey({ orgId: kit.org.id, scopes: ['messages:write'] });
      const key = `rollout-tell:${await releaseId()}`;
      const sent = await post2(fresh.admin(), key, tell('Tell once per release.'));
      expect(sent.status).toBe(201);
      // This principal's own row at the claimant key, written by something else (a pass create once could).
      const keyRow = await first<{ id: string }>(
        kit.env.DB,
        'SELECT id FROM api_keys ORDER BY created_at DESC, id DESC LIMIT 1',
      );
      await run(
        kit.env.DB,
        `INSERT INTO idempotency_keys (org_id, key, request_hash, resource_id, created_at)
         VALUES (?, ?, 'other-hash', 'a-pass-id', ?)`,
        [kit.org.id, `broadcast-create:live:${keyRow?.id}:${key}`, kit.clock.now()],
      );
      const second = await post2(other, key, tell('Tell once per release.'));
      expect(second.status).toBe(409);
      expect(await second.json()).toMatchObject({ code: 'TELL_ALREADY_SENT' });
    });

    it('refuses a client key that borrows another internal prefix', async () => {
      const fresh = await broadcastAuth(kit, ORIGIN);
      for (const prefix of ['broadcast-create:', 'bulk-send:']) {
        const res = await post2(fresh.admin(), `${prefix}live:x`, tell('x'));
        expect(res.status).toBe(422);
        expect(await res.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_RESERVED' });
      }
    });

    it('reserves the prefix: a wrong release, or a body that is not that message, is 422', async () => {
      const fresh = await broadcastAuth(kit, ORIGIN);
      const right = `rollout-tell:${await releaseId()}`;
      const code = async (res: Response) => ((await res.json()) as { code: string }).code;
      const wrong = await post2(fresh.admin(), 'rollout-tell:not-the-release', tell('x'));
      expect(wrong.status).toBe(422);
      expect(await code(wrong)).toBe('IDEMPOTENCY_KEY_RESERVED');
      const noVersion = await post2(fresh.admin(), right, {
        ...tell('x'),
        target: { templateIds: [kit.messaging.id] },
      });
      expect(noVersion.status).toBe(422);
      const change = await post2(fresh.admin(), right, {
        kind: 'change',
        target: { templateIds: [kit.messaging.id] },
        patch: { gate: 'A' },
      });
      expect(change.status).toBe(422);
      const otherVersion = await post2(fresh.admin(), right, {
        ...tell('x'),
        target: { templateIds: [kit.messaging.id], version: 'some-other-version' },
      });
      expect(otherVersion.status).toBe(422);
      const two = await post2(fresh.admin(), right, {
        ...tell('x'),
        target: { templateIds: [kit.messaging.id, kit.plain.id], version },
      });
      expect(two.status).toBe(422);
    });
  });

  it('clears a pass that already showed the same text, as well as those it updated', async () => {
    const fresh = await broadcastAuth(kit, ORIGIN);
    const same = await kit.makePass({ message: 'Doors open at 8.' });
    await run(kit.env.DB, "UPDATE passes SET status = 'voided' WHERE id != ? AND template_id = ?", [
      same.id,
      kit.messaging.id,
    ]);
    const res = await app.request(
      `${ORIGIN}/api/v1/broadcasts`,
      {
        method: 'POST',
        headers: { ...fresh.admin(), 'content-type': 'application/json' },
        body: JSON.stringify({
          orgId: kit.org.id,
          kind: 'message',
          target: { templateIds: [kit.messaging.id] },
          patch: { message: 'Doors open at 8.' },
          clearAfter: 3_600_000,
        }),
      },
      kit.env,
    );
    const sent = (await res.json()) as { id: string };
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
    await exec(sent.id);
    // The pass already showed that text: the run records it unchanged.
    expect(
      await first(kit.env.DB, 'SELECT outcome FROM broadcast_items WHERE broadcast_id = ?', [
        sent.id,
      ]),
    ).toEqual({ outcome: 'unchanged' });
    kit.clock.advance(3_700_000);
    await startDueBroadcasts(jobCtxOf(kit));
    const follow = await first<{ id: string }>(
      kit.env.DB,
      'SELECT id FROM broadcasts WHERE parent_id = ?',
      [sent.id],
    );
    await exec(follow?.id ?? '');
    expect((await getPass(kit.env.DB, same.id, null))?.personalization.message ?? '').toBe('');
  });
});
