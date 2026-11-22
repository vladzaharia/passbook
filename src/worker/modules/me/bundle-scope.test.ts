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

let h: TestHarness;
beforeEach(async () => {
  h = await harness();
});
afterEach(() => h.restore());

async function holder() {
  const f = fixtures(h.env, h.clock);
  const user = await makeUser(f);
  const org = await makeOrg(f, { name: 'Acme' });
  const template = makeTemplate();
  const add = async (mode: 'live' | 'test' = 'live', json?: object) => {
    const pass = await makePass(f, {
      orgId: org.id,
      template: template.resolved,
      ownerUserId: user.id,
      mode,
    });
    if (json) {
      await run(h.env.DB, 'UPDATE passes SET pending_pass_json = ? WHERE id = ?', [
        JSON.stringify(json),
        pass.id,
      ]);
    }
    return pass.id;
  };
  const count = async () =>
    (await bundleSnapshot(createServiceContext(h.env, { clock: h.clock }), user.id))?.count ?? 0;
  return { add, count };
}

const DAY = 86_400_000;
const iso = (offset: number) => new Date(h.clock.now() + offset).toISOString();

describe('Add all scope', () => {
  it('counts live, unexpired passes and leaves out expired, voided-on-card and test ones', async () => {
    const { add, count } = await holder();
    await add();
    await add('live', { expirationDate: iso(DAY) });
    await add('live', { expirationDate: iso(-DAY) });
    await add('live', { voided: true });
    await add('test');
    expect(await count()).toBe(2);
  });

  it('keeps a date-only end through that day and drops it the day after', async () => {
    const { add, count } = await holder();
    await add('live', { expirationDate: iso(0).slice(0, 10) });
    expect(await count()).toBe(1);
    await add('live', { expirationDate: iso(-2 * DAY).slice(0, 10) });
    expect(await count()).toBe(1);
  });

  it('keeps a pass with no end, or an end it cannot read', async () => {
    const { add, count } = await holder();
    await add('live', { expirationDate: 'someday' });
    await add('live', { foo: 1 });
    await add('live', { expirationDate: 1 });
    expect(await count()).toBe(3);
  });

  it('bundles test passes only when no live pass is left to add', async () => {
    const { add, count } = await holder();
    await add('test');
    await add('test');
    expect(await count()).toBe(2);
    await add('live', { expirationDate: iso(-DAY) });
    expect(await count()).toBe(2);
    await add('live');
    expect(await count()).toBe(1);
  });
});
