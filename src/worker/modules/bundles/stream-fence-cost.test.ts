import { expect, it, vi } from 'vitest';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { setupKit } from '../passes/pass-test-fixtures.ts';
import { bundleForToken, fenceBundleStream } from './public-service.ts';
import { createBundle } from './service.ts';

const chunks = (n: number) =>
  new ReadableStream<Uint8Array>({
    pull(controller) {
      if (n-- > 0) controller.enqueue(new Uint8Array([1]));
      else controller.close();
    },
  });

async function drain(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader();
  while (!(await reader.read()).done);
}

it('fences one pass at its first chunk only and an archive at every chunk', async () => {
  const kit = await setupKit();
  const a = await kit.pass();
  const b = await kit.pass();
  const ctx = jobCtxOf(kit);
  const created = await createBundle(
    ctx,
    { type: 'system', id: null },
    'live',
    { orgId: a.orgId, name: 'Fence', passIds: [a.id, b.id] },
    { kind: 'system' },
  );
  const bundle = await bundleForToken(ctx, created.url.split('/b/')[1] ?? '');
  const prepare = vi.spyOn(kit.env.DB, 'prepare');
  const queries = async (passes: (typeof a)[]) => {
    prepare.mockClear();
    await drain(fenceBundleStream(ctx, bundle, passes, chunks(6)));
    return prepare.mock.calls.length;
  };
  const single = await queries([a]);
  const archive = await queries([a, b]);
  prepare.mockRestore();
  expect(single).toBeGreaterThan(0);
  expect(archive).toBeGreaterThan(single * 2);
});
