import { beforeAll, describe, expect, it } from 'vitest';
import {
  type Fixtures,
  fixtures,
  makeEnv,
  makeSession,
  makeUser,
  type SessionFixture,
} from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { ManualClock } from '../../platform/clock.ts';
import { all, first } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createSessionStore } from '../auth/sessions.ts';

const clock = new ManualClock();
const app = createApp({
  stores: (env) => ({ ...denyAllStores, sessions: createSessionStore(env, clock) }),
  clock,
});
let appEnv: AppEnv;
let f: Fixtures;
let admin: SessionFixture;

const post = (path: string, body: unknown) =>
  app.request(
    `/api/v1/orgs${path}`,
    {
      method: 'POST',
      headers: { ...admin.headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    appEnv,
  );
const presetOf = async (id: string) =>
  (
    await first<{ preset: string }>(
      appEnv.DB,
      'SELECT preset FROM org_entitlements WHERE org_id = ?',
      [id],
    )
  )?.preset;

beforeAll(async () => {
  appEnv = await makeEnv();
  f = fixtures(appEnv, clock);
  admin = await makeSession(f, { userId: (await makeUser(f)).id, roles: ['admin', 'user'] });
});

describe('org create writes the entitlements row', () => {
  it('standard when no preset is given', async () => {
    const res = await post('', { slug: 'ent-default', name: 'Default' });
    expect(res.status).toBe(201);
    const org = (await res.json()) as { id: string };
    expect(await presetOf(org.id)).toBe('standard');
  });

  it.each(['legacy', 'trial', 'standard'])('takes preset %s', async (preset) => {
    const res = await post('', { slug: `ent-${preset}`, name: preset, preset });
    expect(res.status).toBe(201);
    expect(await presetOf(((await res.json()) as { id: string }).id)).toBe(preset);
  });

  it('refuses an unknown preset and writes no org', async () => {
    const res = await post('', { slug: 'ent-bad', name: 'Bad', preset: 'gold' });
    expect(res.status).toBe(422);
    expect(await first(appEnv.DB, "SELECT 1 AS x FROM orgs WHERE slug = 'ent-bad'")).toBeNull();
  });

  it('every org created through the API has a row', async () => {
    const orphans = await all(
      appEnv.DB,
      "SELECT o.id FROM orgs o LEFT JOIN org_entitlements e ON e.org_id = o.id WHERE e.org_id IS NULL AND o.slug LIKE 'ent-%'",
    );
    expect(orphans).toEqual([]);
  });
});
