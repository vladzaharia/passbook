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
  Object.assign(kit.env, { DB: counted.db });
  try {
    await kit.post(headers, '/actions', {});
    const guard = counted.count();
    counted.reset();
    clearSettingsCache(counted.db);
    await run();
    const calls = counted
      .tripLog()
      .slice(guard)
      .map((t) => `[${t.length}] ${t.map((q) => q.replace(/\s+/g, ' ').slice(0, 28)).join(' | ')}`);
    return { trips: counted.count() - guard, calls };
  } finally {
    Object.assign(kit.env, { DB: original });
  }
}

const heads = (calls: string[]) => `\n${calls.join('\n')}`;

describe('value action round trips (design 4.7)', () => {
  it('an add that publishes a new artifact: 17 trips, one grant batch writes it', async () => {
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
    // The publish reads its pass, removal, org, personalization and history in one batch (21 before).
    // Fewer needs the claim batch to carry the pass row and the builder's reads to join it.
    expect(trips, heads(calls)).toBeLessThanOrEqual(17);
  });
});
