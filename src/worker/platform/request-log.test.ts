import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { fakeAuth, makeEnv } from '../../../test/helpers/index.ts';
import { type AppBindings, requestContext } from './context.ts';
import { createLogger } from './log.ts';

describe('request.done', () => {
  it('logs a 403 with the route pattern, status and no token', async () => {
    const lines: string[] = [];
    const app = new Hono<AppBindings>();
    app.use(
      '*',
      requestContext({
        stores: fakeAuth('https://wallet.test').stores,
        logger: (base) => createLogger(base, { sink: (line) => lines.push(line) }),
      }),
    );
    app.get('/p/:token', (c) => c.text('no', 403));
    const res = await app.request(
      'https://wallet.test/p/SECRETSECRETSECRET1234',
      {},
      await makeEnv(),
    );
    expect(res.status).toBe(403);
    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0] ?? '{}');
    expect(line).toMatchObject({ event: 'request.done', route: '/p/:token', status: 403 });
    expect(lines[0]).not.toContain('SECRETSECRET');
  });
});
