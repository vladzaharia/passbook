import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  fixtures,
  makeOrg,
  makePass,
  makeTemplate,
  makeUser,
} from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { harness, type TestHarness } from '../auth/test-support.ts';
import { bundleSnapshot } from './bundle.ts';
import { listBundlePasses } from './repo.ts';
import { listMyPasses } from './service.ts';

let h: TestHarness;
beforeEach(async () => {
  h = await harness();
});
afterEach(() => h.restore());

async function setup(count: number) {
  const f = fixtures(h.env, h.clock);
  const user = await makeUser(f);
  const org = await makeOrg(f, { name: 'Acme' });
  const template = makeTemplate();
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const pass = await makePass(f, {
      orgId: org.id,
      template: template.resolved,
      ownerUserId: user.id,
    });
    ids.push(pass.id);
  }
  return { user, org, ids: ids.sort().reverse() };
}

const part = async (userId: string, token: string, n: number) => {
  const starts = token.split(',');
  const rows = await listBundlePasses(
    h.env.DB,
    userId,
    { first: starts[n - 1] as string, after: starts[n] ?? null },
    10,
  );
  return rows.map((row) => row.id);
};

describe('Add all snapshot', () => {
  it('splits twelve passes into two parts and keeps part two whole when part one shrinks', async () => {
    const { user, ids } = await setup(12);
    const ctx = createServiceContext(h.env, { clock: h.clock });
    const snapshot = await bundleSnapshot(ctx, user.id);
    expect(snapshot).toMatchObject({ count: 12, parts: 2 });
    const token = snapshot?.token ?? '';
    // Part one's first pass leaves the set (added to Wallet, removed): an OFFSET would skip two.
    await run(h.env.DB, 'UPDATE passes SET removed_at = 1 WHERE id = ?', [ids[0]]);
    expect(await part(user.id, token, 1)).toEqual(ids.slice(1, 10));
    expect(await part(user.id, token, 2)).toEqual(ids.slice(10));
  });

  it('leaves out passes of a suspended org', async () => {
    const { user, org } = await setup(2);
    await run(h.env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [org.id]);
    const ctx = createServiceContext(h.env, { clock: h.clock });
    expect(await bundleSnapshot(ctx, user.id)).toBeNull();
  });
});

describe('a pass that changes while the list is read', () => {
  it('is built again, not dropped', async () => {
    const { user, ids } = await setup(2);
    // The first snapshot batch finds revision bumped, as a refresh landing between the reads.
    const real = h.env.DB;
    let bumped = false;
    const db = new Proxy(real, {
      get(target, key) {
        if (key === 'batch') {
          return async (statements: D1PreparedStatement[]) => {
            if (!bumped) {
              bumped = true;
              await run(real, 'UPDATE passes SET revision = revision + 1 WHERE id = ?', [ids[0]]);
            }
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const ctx = createServiceContext({ ...h.env, DB: db }, { clock: h.clock });
    const page = await listMyPasses(ctx, user.id, { limit: 10 });
    expect(bumped).toBe(true);
    expect(page.items.map((item) => item.id).sort()).toEqual([...ids].sort());
  });
});
