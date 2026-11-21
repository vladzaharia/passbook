import { beforeAll, describe, expect, it } from 'vitest';
import {
  fixtures,
  makeEnv,
  makeOrg,
  makeSession,
  makeUser,
} from '../../../../test/helpers/index.ts';
import { snapshotSql } from '../../../../tools/lib/bootstrap-tenancy.ts';
import { first } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { ensurePersonalOrg } from './personal.ts';

let env: AppEnv;
beforeAll(async () => {
  env = await makeEnv();
});

describe('bootstrap snapshot', () => {
  it("leaves another admin's personal org out, so its one-member rule is never hit", async () => {
    const f = fixtures(env);
    const owner = await makeUser(f);
    const other = await makeUser(f);
    const session = await makeSession(f, { userId: other.id, roles: ['admin', 'user'] });
    await ensurePersonalOrg(createServiceContext(env, { clock: f.clock }), {
      userId: other.id,
      sessionId: await sha256Hex(session.cookieValue),
    });
    const ordinary = await makeOrg(f);
    const row = await first<Record<string, string>>(env.DB, snapshotSql(owner.primaryEmail));
    const snapshot = JSON.parse(Object.values(row ?? {})[0] ?? '{}') as {
      orgs: { id: string; slug: string }[];
    };
    const slugs = snapshot.orgs.map((o) => o.slug);
    expect(slugs).toContain(ordinary.slug);
    expect(slugs.filter((slug) => slug.startsWith('personal-'))).toEqual([]);
  });
});
