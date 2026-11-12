import { expect, it } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { first } from '../../platform/db.ts';
import { act, CHECK_IN, kit, mask, out, tpl } from './act-test-fixtures.ts';
import { safeDisplay } from './outcome.ts';
import { codeOf, key } from './test-kit.ts';

export function registerFailures() {
  it('a refused body for an unknown code is the same across orgs, display null included', async () => {
    const orgB = await makeOrg(kit.fx, { name: 'Other Gym' });
    const tplB = await kit.scanTemplate('Gym card', { actions: [CHECK_IN] }, { orgId: orgB.id });
    const passB = await kit.scanPass(tplB, {}, { orgId: orgB.id });
    const s = await kit.scanner({ templateIds: [tpl] });
    const random = mask(await out(await act(s.headers, { code: 'ZZZZ-NOPE', method: 'camera' })));
    const foreign = mask(await out(await act(s.headers, codeOf(passB))));
    expect(foreign).toEqual(random);
    expect(random).toMatchObject({ reason: 'not_found', display: null, card: null });
  });

  it('a display that fails to build is logged and the verdict still goes out without it', () => {
    const errors: unknown[] = [];
    const ctx = {
      ...kit.ctx,
      log: { ...kit.ctx.log, error: (_: string, data: unknown) => errors.push(data) },
    };
    const broken = {
      id: 'p',
      get displayTitle(): string {
        throw new Error('display exploded');
      },
    };
    expect(safeDisplay(ctx as never, {} as never, broken, 'ok')).toBeNull();
    expect(errors).toMatchObject([{ code: 'SCAN_DISPLAY_FAILED', screen: 'ok' }]);
    expect(safeDisplay(ctx as never, {} as never, null, 'refused')).toBeNull();
  });

  // The claim commits with its grant (batch 2 or 3), so a failure there leaves no row; a failure in the
  // commit (batch 4) leaves a released, failed row. Either way the same key runs again.
  it.each([
    [2, null],
    [3, null],
    [4, 'failed'],
  ] as const)(
    'an unexpected error in batch %i leaves row %s and the same key runs again',
    async (failAt, expectedState) => {
      const s = await kit.scanner({ templateIds: [tpl] });
      const pass = await kit.scanPass(tpl);
      const idempotencyKey = key();
      const realBatch = kit.env.DB.batch.bind(kit.env.DB);
      let calls = 0;
      const db = new Proxy(kit.env.DB, {
        get(target, prop) {
          if (prop === 'batch')
            return (...args: Parameters<typeof realBatch>) =>
              ++calls === failAt ? Promise.reject(new Error('D1 down')) : realBatch(...args);
          const v = Reflect.get(target, prop, target);
          return typeof v === 'function' ? v.bind(target) : v;
        },
      });
      const original = kit.env.DB;
      Object.assign(kit.env, { DB: db });
      try {
        expect((await act(s.headers, codeOf(pass), { idempotencyKey })).status).toBe(500);
      } finally {
        Object.assign(kit.env, { DB: original });
      }
      const failed = await first<{ state: string }>(
        kit.env.DB,
        'SELECT state FROM scans WHERE idempotency_key = ?',
        [idempotencyKey],
      );
      expect(failed?.state ?? null).toBe(expectedState);
      const retry = await out(await act(s.headers, codeOf(pass), { idempotencyKey }));
      expect(retry).toMatchObject({ kind: 'ok', replay: false });
    },
  );
}
