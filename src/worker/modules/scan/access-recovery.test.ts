import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TEST_NOW } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { accessTemplate, gateRow, makeDoor } from './access-test-fixtures.ts';
import { stage } from './act-recovery-test-fixtures.ts';
import { kit, setupActionFixture } from './act-test-fixtures.ts';
import { reconcileScans } from './jobs.ts';
import { type GateSnapshot, releaseObservedGateStmt } from './repo-gate-recovery.ts';
import { scanByKey } from './repo-scans.ts';
import { key } from './test-kit.ts';

beforeAll(setupActionFixture);
afterEach(() => kit.clock.set(TEST_NOW));

const snapshot = (actionId: string, count: number): GateSnapshot => ({
  pass_id: 'p',
  action_id: actionId,
  scope: actionId === 'access' ? 'access' : '',
  org_id: 'o',
  mode: 'live',
  template_id: 't',
  kind: 'check_in',
  state: 'in',
  count,
  first_at: 1,
  last_at: 2,
  last_scan_id: 's',
  prev_state: count > 1 ? 'in' : null,
  prev_last_at: count > 1 ? 1 : null,
  prev_scan_id: count > 1 ? 'r' : null,
  previous_scan_state: null,
  previous_scan_at: null,
});

describe('gate recovery: access gates', () => {
  it('never releases a visit gate, first grant or later', () => {
    expect(releaseObservedGateStmt(kit.env.DB, snapshot('access', 1), 2)).toBeNull();
    expect(releaseObservedGateStmt(kit.env.DB, snapshot('access', 3), 2)).toBeNull();
    // An action's own gate is still released.
    expect(releaseObservedGateStmt(kit.env.DB, snapshot('check_in', 1), 2)).not.toBeNull();
  });

  it('fails a pending claim that a visit gate points at, and keeps the count and visit start', async () => {
    const tpl = await accessTemplate();
    const door = await makeDoor([tpl]);
    const pass = await kit.scanPass(tpl, { plan: 'gold' });
    const k = key();
    await stage(door.scanner, pass, k);
    const claimed = await scanByKey(kit.env.DB, `s:${door.scanner.id}`, k);
    if (!claimed) throw new Error('Missing pending claim');
    const at = kit.clock.now();
    await run(
      kit.env.DB,
      `INSERT INTO scan_gates (pass_id, org_id, mode, action_id, scope, template_id, kind, state, count,
         first_at, last_at, last_scan_id, visit_at)
       VALUES (?, ?, 'live', 'access', 'access', ?, 'check_in', 'in', 1, ?, ?, ?, ?)`,
      [pass.id, kit.org.id, tpl, at, at, claimed.id, at],
    );
    const before = await gateRow(pass.id);
    kit.clock.advance(61_000);
    await reconcileScans(createServiceContext(kit.env, { clock: kit.clock }));
    expect(await first(kit.env.DB, 'SELECT state FROM scans WHERE id = ?', [claimed.id])).toEqual({
      state: 'failed',
    });
    expect(await gateRow(pass.id)).toEqual(before);
  });
});
