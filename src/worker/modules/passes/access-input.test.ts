import { beforeAll, describe, expect, it } from 'vitest';
import type { AccessManifest } from '../../../passkit/types.ts';
import { run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { type ScanKit, setupScanKit } from '../scan/test-kit.ts';
import { accessInputIssues } from './access-input.ts';
import { updatePass } from './service.ts';

const ACCESS: AccessManifest = {
  input: { plan: 'plan', zones: 'zones', from: 'from', until: 'until', visits: 'visits' },
  plans: [
    { id: 'gold', label: 'Gold', kind: 'always', zones: [{ zone: '*' }] },
    { id: 'guest', label: 'Guest', kind: 'guest', zones: [{ zone: '*' }], visits: 2 },
  ],
};
const KEYS = new Set(['pool']);
const codes = (input: Record<string, unknown>) =>
  accessInputIssues(ACCESS, input as never, KEYS).map((i) => [i.path, i.code]);

describe('accessInputIssues', () => {
  it('accepts a plan, live zones, a window and a guest limit', () => {
    expect(codes({ plan: 'gold', zones: ['pool'] })).toEqual([]);
    expect(
      codes({
        plan: 'guest',
        visits: 3,
        from: '2026-06-01T00:00:00Z',
        until: '2026-06-02T00:00:00Z',
      }),
    ).toEqual([]);
  });

  it('names each broken input and its code', () => {
    expect(codes({ plan: 'platinum' })).toEqual([['plan', 'ACCESS_PLAN_UNKNOWN']]);
    expect(codes({})).toEqual([['plan', 'ACCESS_PLAN_UNKNOWN']]);
    expect(codes({ plan: 'gold', zones: ['pool', 'sauna'] })).toEqual([
      ['zones', 'ACCESS_ZONE_UNKNOWN'],
    ]);
    expect(codes({ plan: 'gold', zones: ['*'] })).toEqual([['zones', 'ACCESS_ZONE_UNKNOWN']]);
    expect(
      codes({ plan: 'gold', from: '2026-06-02T00:00:00Z', until: '2026-06-02T00:00:00Z' }),
    ).toEqual([['until', 'ACCESS_WINDOW']]);
    expect(codes({ plan: 'gold', visits: 2 })).toEqual([['visits', 'ACCESS_VISITS']]);
  });
});

describe('access input on create and update', () => {
  let kit: ScanKit;
  let tpl: string;
  beforeAll(async () => {
    kit = await setupScanKit();
    tpl = await kit.scanTemplate('Access input', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
      access: ACCESS,
    });
    const now = kit.clock.now();
    await run(
      kit.env.DB,
      `INSERT INTO scan_zones (id, org_id, key, name, created_at, updated_at) VALUES (?, ?, 'pool', 'Pool', ?, ?)`,
      [kit.fx.ids.id(), kit.org.id, now, now],
    );
    await run(
      kit.env.DB,
      `INSERT INTO scan_zones (id, org_id, key, name, created_at, updated_at, archived_at)
       VALUES (?, ?, 'old', 'Old', ?, ?, ?)`,
      [kit.fx.ids.id(), kit.org.id, now, now, now],
    );
  });

  const refused = (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (e: { status: number; code: string; issues?: { path: string; code?: string }[] }) => e,
    );

  it('refuses an unknown plan, an archived zone and a bad window with 422 and a path', async () => {
    const unknown = await refused(kit.scanPass(tpl, { plan: 'nope' }));
    expect(unknown).toMatchObject({
      status: 422,
      code: 'ACCESS_PLAN_UNKNOWN',
      issues: [{ path: 'plan', code: 'ACCESS_PLAN_UNKNOWN' }],
    });
    expect(await refused(kit.scanPass(tpl, { plan: 'gold', zones: ['old'] }))).toMatchObject({
      status: 422,
      code: 'ACCESS_ZONE_UNKNOWN',
    });
    expect(
      await refused(
        kit.scanPass(tpl, {
          plan: 'gold',
          from: '2026-06-02T00:00:00Z',
          until: '2026-06-01T00:00:00Z',
        }),
      ),
    ).toMatchObject({ status: 422, code: 'ACCESS_WINDOW' });
    expect(await refused(kit.scanPass(tpl, { plan: 'gold', visits: 3 }))).toMatchObject({
      status: 422,
      code: 'ACCESS_VISITS',
    });
  });

  it('checks the merged input on an update, and leaves other templates alone', async () => {
    const pass = await kit.scanPass(tpl, { plan: 'gold', zones: ['pool'] });
    const admin = { type: 'user', id: 'admin-1' } as const;
    const patch = (input: Record<string, unknown>) =>
      updatePass(jobCtxOf(kit), admin, pass.id, { input: input as never }, { scope: kit.org.id });
    expect(await refused(patch({ plan: 'platinum' }))).toMatchObject({
      status: 422,
      code: 'ACCESS_PLAN_UNKNOWN',
    });
    expect(await refused(patch({ visits: 4 }))).toMatchObject({
      status: 422,
      code: 'ACCESS_VISITS',
    });
    expect(await refused(patch({ plan: 'guest', visits: 4 }))).toBeNull();

    const plain = await kit.scanTemplate('Plain', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
    });
    const other = await kit.scanPass(plain, { plan: 'platinum' });
    expect(
      await refused(
        updatePass(jobCtxOf(kit), admin, other.id, { input: { plan: 'x' } }, { scope: kit.org.id }),
      ),
    ).toBeNull();
  });
});
