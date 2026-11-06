import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import { putPassCheckIn } from '../passes/check-in.ts';
import { presenceOf } from './repo-admission.ts';
import { codeOf, key, setupScanKit } from './test-kit.ts';

it('backfills legacy usage without inventing occupancy and preserves single-use limits after pruning', async () => {
  const kit = await setupScanKit();
  const template = await kit.scanTemplate('Legacy membership', {
    actions: [
      { id: 'check_in', label: 'Check in', kind: 'check_in' },
      { id: 'other', label: 'Another action', kind: 'check_in' },
    ],
  });
  const pass = await kit.scanPass(template);
  const scanner = await kit.scanner({ templateIds: [template] });
  const read = async (actionId = 'check_in') => {
    const response = await kit.post(scanner.headers, '/actions', {
      input: codeOf(pass),
      actionId,
      clientTs: kit.clock.now(),
      idempotencyKey: key(),
    });
    return response.json() as Promise<{
      kind: string;
      reason: string;
      checkIn: { direction: string };
    }>;
  };
  expect((await read()).kind).toBe('ok');
  const firstAt = kit.clock.now();
  kit.clock.advance(60_000);
  expect((await read('other')).kind).toBe('ok');
  expect(await presenceOf(kit.env.DB, pass.orgId, pass.id, '')).toBeNull();
  const backfill = env.TEST_MIGRATIONS.find(
    (m) => m.name === '0022_scan_check_in.sql',
  )?.queries.find((q) => q.includes('INSERT INTO scan_presence'));
  if (!backfill) throw new Error('The admission migration is missing its backfill.');
  await kit.env.DB.prepare(backfill).run();
  expect(await presenceOf(kit.env.DB, pass.orgId, pass.id, '')).toMatchObject({
    first_at: firstAt,
    last_entry_at: kit.clock.now(),
    tracking: 0,
  });
  await run(kit.env.DB, 'DELETE FROM scans WHERE pass_id=?', [pass.id]);
  await putPassCheckIn(kit.ctx, { type: 'system', id: null }, pass.id, { mode: 'single' }, null);
  expect(await read()).toMatchObject({ kind: 'heads_up', reason: 'already_done' });
  await putPassCheckIn(kit.ctx, { type: 'system', id: null }, pass.id, { mode: 'in_out' }, null);
  expect((await read()).checkIn.direction).toBe('in');
});
