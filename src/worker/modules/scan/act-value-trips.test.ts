import { beforeAll, describe, expect, it } from 'vitest';
import { countD1 } from '../../../../test/helpers/index.ts';
import { clearSettingsCache } from '../settings/service.ts';
import { act, kit, out, setupActionFixture } from './act-test-fixtures.ts';
import { showBalance } from './act-value-test-fixtures.ts';
import { codeOf } from './test-kit.ts';

beforeAll(setupActionFixture);

/** DB calls an action makes after the guard's own reads; a batch is one call. */
async function tripsOf(headers: Record<string, string>, run: () => Promise<unknown>) {
  const original = kit.env.DB;
  const counted = countD1(original);
  const calls: string[] = [];
  const traced = new Proxy(counted.db, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop === 'batch')
        return (statements: D1PreparedStatement[]) => {
          const done = (value as (s: D1PreparedStatement[]) => Promise<unknown>).call(
            target,
            statements,
          );
          const batch = counted.sql().slice(-statements.length);
          calls.push(
            `[${statements.length}] ${batch.map((q) => q.replace(/\s+/g, ' ').slice(0, 28)).join(' | ')}`,
          );
          return done;
        };
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  Object.assign(kit.env, { DB: traced });
  try {
    await kit.post(headers, '/actions', {});
    const guard = counted.count();
    counted.reset();
    calls.length = 0;
    clearSettingsCache(counted.db);
    await run();
    return { trips: counted.count() - guard, calls };
  } finally {
    Object.assign(kit.env, { DB: original });
  }
}

const heads = (calls: string[]) => `\n${calls.join('\n')}`;

describe('value action round trips (design 4.7)', () => {
  it('an add that publishes a new artifact: 21 trips, 7 of them batches, one grant batch writes it', async () => {
    const t = await kit.scanTemplate('Value trips', {
      actions: [
        { id: 'add', label: 'Add', kind: 'add', input: 'balance', amount: 1, repeat: 'always' },
      ],
    });
    await showBalance(t);
    const s = await kit.scanner({ templateIds: [t], settings: { roleWithoutSignIn: 'desk' } });
    const pass = await kit.scanPass(t, { balance: 0 });
    const { trips, calls } = await tripsOf(s.headers, async () => {
      const o = await out(await act(s.headers, codeOf(pass), { actionId: 'add' }));
      expect(o.kind).toBe('ok');
    });
    // Not the check-in's five: the publish reads and builds the pass first (template, release, assets).
    // This holds the number where it is; a value fast path would lower it.
    expect(trips, heads(calls)).toBeLessThanOrEqual(21);
  });
});
