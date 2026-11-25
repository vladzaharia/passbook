import { beforeAll, describe, expect, it } from 'vitest';
import {
  fixtures,
  makeEnv,
  makeOrg,
  makeSession,
  makeUser,
  type SessionFixture,
} from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { ManualClock } from '../../platform/clock.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createSessionStore } from '../auth/sessions.ts';

const clock = new ManualClock();
const app = createApp({
  stores: (env) => ({ ...denyAllStores, sessions: createSessionStore(env, clock) }),
  clock,
});
let appEnv: AppEnv;
let admin: SessionFixture;
let customer = '';
let sandbox = '';
const list = async (query = '') => {
  const res = await app.request(`/api/v1/orgs${query}`, { headers: admin.headers }, appEnv);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { items: { id: string }[] };
  return body.items.map((o) => o.id);
};

beforeAll(async () => {
  appEnv = await makeEnv();
  const f = fixtures(appEnv, clock);
  admin = await makeSession(f, { userId: (await makeUser(f)).id, roles: ['admin', 'user'] });
  customer = (await makeOrg(f, { name: 'Customer' })).id;
  sandbox = (await makeOrg(f, { name: 'Sandbox', kind: 'developer' })).id;
});

describe('platform organization list and developer sandboxes', () => {
  it('leaves sandboxes out unless asked', async () => {
    const ids = await list();
    expect(ids).toContain(customer);
    expect(ids).not.toContain(sandbox);
  });

  it('adds them with sandboxes=show and lists only them with sandboxes=only', async () => {
    expect(await list('?sandboxes=show')).toEqual(expect.arrayContaining([customer, sandbox]));
    expect(await list('?sandboxes=only')).toEqual([sandbox]);
  });
});
