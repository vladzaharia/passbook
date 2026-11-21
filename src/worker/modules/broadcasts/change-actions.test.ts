import { beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { persistTemplate } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { TINY_PNG } from '../passes/pass-test-fixtures.ts';
import { publishPass } from '../passes/publish.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { applyChunk } from './apply.ts';
import { type ChangeKit, changeKit } from './change-fixtures.ts';

let ck: ChangeKit;
beforeAll(async () => {
  ck = await changeKit();
});

const state = async (id: string) => (await getPass(ck.kit.env.DB, id, null))?.status;
const ask = (id: string) => ck.post(`/broadcasts/${id}/undo`);
const voidRun = (passIds: string[], extra: Record<string, unknown> = {}) =>
  ck.change({ target: { passIds, ...extra }, patch: { $void: true }, notify: false });

describe('void runs', () => {
  it('voids each pass, keeps the status and version for the undo, and undoes only untouched ones', async () => {
    const [a, b, c] = [await ck.kit.makePass(), await ck.kit.makePass(), await ck.kit.makePass()];
    if (!a || !b || !c) throw new Error('passes');
    const done = await voidRun([a.id, b.id, c.id], { expectCount: 3 });
    expect(done).toMatchObject({ state: 'sent', counts: { updated: 3 } });
    expect(await state(a.id)).toBe('voided');
    const items = await ck.items(done.id);
    expect(JSON.parse(items[0]?.before ?? '{}')).toMatchObject({
      action: 'void',
      from: { status: 'active' },
      to: { status: 'voided' },
    });
    // A later write to b keeps it voided.
    await publishPass(jobCtxOf(ck.kit), {
      passId: b.id,
      cause: 'admin',
      actor: { type: 'system', id: null },
      notify: false,
      mutate: (p) => ({ personalization: { ...p.personalization, gate: 'X' } }),
    });
    const res = await ask(done.id);
    expect(res.status).toBe(200);
    await ck.runNext();
    const undo = await ck.get(((await res.json()) as { id: string }).id);
    expect(undo.counts).toMatchObject({ updated: 2, unchanged: 1 });
    expect(await state(a.id)).toBe('active');
    expect(await state(b.id)).toBe('voided');
    expect(await state(c.id)).toBe('active');
  });

  it('refuses a drifted count, extra keys and a message', async () => {
    const a = await ck.kit.makePass();
    const send = (body: Record<string, unknown>) =>
      ck.post('/broadcasts', { orgId: ck.kit.org.id, kind: 'change', ...body });
    await expectProblem(
      await send({ target: { passIds: [a.id], expectCount: 40 }, patch: { $void: true } }),
      409,
      'SELECTION_CHANGED',
    );
    expect(
      (await send({ target: { passIds: [a.id] }, patch: { $void: true, gate: 'x' } })).status,
    ).toBe(422);
    expect(
      (await send({ target: { passIds: [a.id] }, patch: { $void: true }, message: 'Hi' })).status,
    ).toBe(422);
  });

  it('proves the creator in the write: a revoked key voids nothing', async () => {
    const a = await ck.kit.makePass();
    const key = await ck.auth.apiKey({
      orgId: ck.kit.org.id,
      scopes: ['messages:write', 'passes:write'],
    });
    const res = await ck.post(
      '/broadcasts',
      { orgId: ck.kit.org.id, kind: 'change', target: { passIds: [a.id] }, patch: { $void: true } },
      key,
    );
    const { id } = (await res.json()) as { id: string };
    const row = await first<{ created_by_id: string }>(
      ck.kit.env.DB,
      'SELECT created_by_id FROM broadcasts WHERE id = ?',
      [id],
    );
    await run(ck.kit.env.DB, 'UPDATE api_keys SET revoked_at = ? WHERE id = ?', [
      ck.kit.clock.now(),
      row?.created_by_id ?? '',
    ]);
    await applyChunk(jobCtxOf(ck.kit), id, null);
    expect(await state(a.id)).toBe('active');
    expect(await ck.get(id)).toMatchObject({ state: 'failed', errorCode: 'CREATOR_REVOKED' });
  });

  it('previews the status change', async () => {
    const a = await ck.kit.makePass();
    const res = await ck.post('/broadcasts/preview', {
      orgId: ck.kit.org.id,
      target: { passIds: [a.id] },
      patch: { $void: true },
    });
    const body = (await res.json()) as {
      samples: { changes: { to: string }[] }[];
      notified: number;
      silent: number;
    };
    expect(body.samples[0]?.changes[0]?.to).toBe('Voided');
    expect(body).toMatchObject({ notified: 0, silent: 1 });
  });
});

describe('latest design runs', () => {
  it('moves passes to the approved release, leaves those already on it, and cannot be undone', async () => {
    const old = await ck.kit.makePass({ gate: 'A' });
    const fresh = await ck.kit.makePass({ gate: 'B' });
    const resolved = await ck.kit.registry.resolve(ck.kit.messaging.id);
    const next = ck.kit.registry.add({
      id: ck.kit.messaging.id,
      version: 'v2',
      manifest: resolved.manifest,
      passJson: { ...resolved.passJson, description: 'New design' },
      assets: { 'icon.png': TINY_PNG },
    });
    await persistTemplate(ck.kit.fx, next, { registry: ck.kit.registry });
    await approveAppleRelease(ck.kit, {
      templateId: ck.kit.messaging.id,
      version: 'v2',
      orgId: ck.kit.org.id,
      mode: 'live',
    });
    const preview = (await (
      await ck.post('/broadcasts/preview', {
        orgId: ck.kit.org.id,
        target: { passIds: [old.id, fresh.id] },
        patch: { $design: true },
      })
    ).json()) as { unchanged: number; samples: { changes: { label: string; to: string }[] }[] };
    expect(preview.unchanged).toBe(0);
    expect(preview.samples[0]?.changes[0]).toMatchObject({ label: 'Design', to: 'v2' });
    const done = await ck.change({
      target: { passIds: [old.id, fresh.id], expectCount: 2 },
      patch: { $design: true },
      notify: false,
    });
    expect(done.counts).toMatchObject({ updated: 2, unchanged: 0 });
    const again = await ck.change({
      target: { passIds: [old.id, fresh.id] },
      patch: { $design: true },
      notify: false,
    });
    expect(again.counts).toMatchObject({ updated: 0, unchanged: 2 });
    expect((await getPass(ck.kit.env.DB, old.id, null))?.templateVersion).toBe('v2');
    await expectProblem(await ask(done.id), 409, 'BROADCAST_NOT_UNDOABLE');
  });
});

describe('the list', () => {
  it('filters by kind', async () => {
    await ck.post('/broadcasts', {
      orgId: ck.kit.org.id,
      kind: 'message',
      send: 'draft',
      target: { templateIds: [ck.kit.messaging.id] },
      patch: { message: 'Hi' },
    });
    const kinds = async (kind: string) =>
      (
        (await (
          await ck.api(`/broadcasts?orgId=${ck.kit.org.id}&kind=${kind}&limit=100`, {
            headers: ck.auth.admin(),
          })
        ).json()) as { items: { kind: string }[] }
      ).items.map((b) => b.kind);
    expect(new Set(await kinds('change'))).toEqual(new Set(['change']));
    expect(new Set(await kinds('message'))).toEqual(new Set(['message']));
  });
});
