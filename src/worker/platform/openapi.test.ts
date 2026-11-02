import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { handleError } from './error-handler.ts';
import { createRouter, register } from './openapi.ts';

const Item = z.object({ id: z.string(), n: z.number() });

function app(body: unknown) {
  const router = createRouter();
  router.onError(handleError);
  register(
    router,
    'test',
    {
      method: 'post',
      path: '/x/{id}',
      summary: 'x',
      params: z.object({ id: z.string() }),
      body: z.object({ n: z.coerce.number() }),
      response: Item,
    },
    // The cast is the point: a handler that ships the wrong shape.
    async (c) =>
      c.json({ id: c.req.valid('param').id, n: (body as { n: unknown }).n } as {
        id: string;
        n: number;
      }),
  );
  return router;
}

const post = (router: ReturnType<typeof app>) =>
  router.request('/x/a', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ n: 1 }),
  });

describe('register', () => {
  it('passes a body that matches its response schema', async () => {
    const res = await post(app({ n: 2 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'a', n: 2 });
  });

  it('fails a body that breaks its response schema', async () => {
    const res = await post(app({ n: 'two' }));
    expect(res.status).toBe(500);
  });

  it('types valid() from the spec', () => {
    const router = createRouter();
    register(router, 'test', { method: 'get', path: '/y', summary: 'y' }, (c) => {
      // @ts-expect-error a route without a body has nothing to read
      c.req.valid('json');
      return c.json({});
    });
    expect(router).toBeDefined();
  });
});
