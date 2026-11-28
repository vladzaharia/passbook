import { expect, it } from 'vitest';
import { fakeAuth } from '../../test/helpers/index.ts';
import { createApp } from './app.ts';

it('mounts the route table in a fixed order', async () => {
  const app = createApp({ stores: fakeAuth().stores });
  const table = app.routes.map((r) => `${r.method} ${r.path}`).join('\n');
  await expect(`${table}\n`).toMatchFileSnapshot('__snapshots__/app-routes.txt');
});
