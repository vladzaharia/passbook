import { expect, it, vi } from 'vitest';
import { createApp } from '../../app.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { reassignHolder } from '../holders/service.ts';
import { putMemberPhoto } from '../passes/member-photo.ts';
import { setupKit } from '../passes/pass-test-fixtures.ts';
import { memberPhoto } from '../passes/repo-member-photo.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { createBundle } from './service.ts';

const actor = { type: 'system', id: null } as const;
const deferred = Promise as PromiseConstructor & {
  withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void };
};

it('cancels an image stream when a real transfer starts while its first chunk opens', async () => {
  const kit = await setupKit();
  const created = await kit.pass({ holderEmail: 'old-image@example.test' });
  const other = await kit.pass();
  const png = makePng(270, 270);
  await putMemberPhoto(
    jobCtxOf(kit),
    actor,
    created.id,
    { png: btoa(String.fromCharCode(...png)), includeInPass: true },
    null,
  );
  const pass = await getPass(kit.env.DB, created.id);
  const photo = await memberPhoto(kit.env.DB, created.orgId, created.id);
  if (!pass || !photo) throw new Error('Missing pass photo');
  const bundle = await createBundle(
    jobCtxOf(kit),
    actor,
    'live',
    {
      orgId: pass.orgId,
      name: 'Images',
      passIds: [pass.id, other.id],
    },
    { kind: 'system' },
  );
  const token = bundle.url.split('/b/')[1] ?? '';
  const opened = deferred.withResolvers<void>();
  const resume = deferred.withResolvers<void>();
  const originalGet = kit.env.BUCKET.get.bind(kit.env.BUCKET);
  let wrapped = false;
  let cancelled = false;
  const spy = vi.spyOn(kit.env.BUCKET, 'get').mockImplementation(async (key, options) => {
    const object = await originalGet(key, options);
    if (key !== photo.r2_key || !object || wrapped) return object;
    wrapped = true;
    const reader = object.body.getReader();
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          opened.resolve();
          await resume.promise;
          const result = await reader.read();
          if (result.done) controller.close();
          else controller.enqueue(result.value);
        },
        async cancel(reason) {
          cancelled = true;
          await reader.cancel(reason);
        },
      },
      { highWaterMark: 0 },
    );
    return new Proxy(object, {
      get(target, property) {
        if (property === 'body') return body;
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  });
  const app = createApp({ clock: kit.clock });
  try {
    const response = await app.request(
      `https://wallet.test/b/${token}/${pass.id}/assets/thumbnail@3x.png`,
      {},
      kit.env,
    );
    expect(response.status).toBe(200);
    if (!response.body) throw new Error('Missing image stream');
    const reader = response.body.getReader();
    const pending = reader.read();
    await opened.promise;
    const holder = await reassignHolder(
      jobCtxOf(kit),
      actor,
      { passId: pass.id, email: 'new-image@example.test' },
      null,
    );
    expect(holder.transfer?.state).toBe('completed');
    resume.resolve();
    await expect(pending).rejects.toMatchObject({ status: 404 });
    expect(cancelled).toBe(true);
    const unaffected = await app.request(
      `https://wallet.test/b/${token}/${other.id}/pass.pkpass`,
      {},
      kit.env,
    );
    expect(unaffected.status).toBe(200);
  } finally {
    resume.resolve();
    spy.mockRestore();
  }
}, 120_000);
