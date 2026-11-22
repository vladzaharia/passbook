import { beforeAll, describe, expect, it } from 'vitest';
import { fakeAuth, fixtures, makeEnv, makeOrg, makeUser } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from './service.ts';

const fake = fakeAuth();
const app = createApp({ stores: fake.stores });
let env: AppEnv;
beforeAll(async () => {
  env = await makeEnv();
});

describe('tag_keyset.rekeyed audit detail', () => {
  it('shows tag ids and the count, never key material, capped at 20', async () => {
    const f = fixtures(env);
    const org = await makeOrg(f);
    const admin = await makeUser(f);
    const ids = Array.from({ length: 25 }, () => f.ids.id());
    await recordAudit(createServiceContext(env), {
      orgId: org.id,
      actorType: 'user',
      actorId: admin.id,
      action: 'tag_keyset.rekeyed',
      targetType: 'tag_keyset',
      targetId: f.ids.id(),
      detail: { count: 25, tagIds: ids, key: 'aa'.repeat(16), apiKey: 'wlt_secret' },
    });
    const res = await app.request(
      `/api/v1/audit/platform?orgId=${org.id}`,
      { headers: fake.admin() },
      env,
    );
    const body = (await res.json()) as {
      items: { action: string; detail: Record<string, unknown> }[];
    };
    const entry = body.items.find((i) => i.action === 'tag_keyset.rekeyed');
    expect(entry?.detail).toEqual({ count: 25, tagIds: ids.slice(0, 20) });
    expect(JSON.stringify(entry)).not.toContain('aaaaaaaa');
    expect(JSON.stringify(entry)).not.toContain('wlt_secret');
  });
});
