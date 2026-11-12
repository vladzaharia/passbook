import { beforeAll, expect } from 'vitest';
import type { ScannerFixture } from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { reconcileScans } from './jobs.ts';
import { claimScan } from './repo-scans.ts';
import { type ScanKit, setupScanKit } from './test-kit.ts';

export let kit: ScanKit;
export let tpl: string;
export let scanners: Record<'live' | 'test', ScannerFixture>;
export const DAY = 86_400_000;
const CHECK_IN = { id: 'check_in', label: 'Check in', kind: 'check_in' } as const;

export function registerJobsFixture() {
  beforeAll(async () => {
    kit = await setupScanKit();
    tpl = await kit.scanTemplate('Gym card', {
      actions: [CHECK_IN],
      lookup: { input: 'memberNo' },
    });
    scanners = {
      live: await kit.scanner({ mode: 'live', templateIds: [tpl] }),
      test: await kit.scanner({ mode: 'test', templateIds: [tpl] }),
    };
  });
}

/** A real scanner's interrupted claim, optionally with legacy pass/action fields. */
export async function pending(
  passId: string | null,
  ageMs: number,
  kind = 'check_in',
  mode: 'live' | 'test' = 'live',
) {
  const id = kit.fx.ids.id();
  await claimScan(kit.env.DB, {
    id,
    orgId: kit.org.id,
    mode,
    scannerId: scanners[mode].id,
    eventId: null,
    actorType: 'scanner',
    actorId: scanners[mode].id,
    actorKey: `s:${scanners[mode].id}`,
    staffId: null,
    idempotencyKey: id,
    requestHash: 'h',
    method: 'camera',
    clientTs: 1,
    now: kit.clock.now() - ageMs,
  });
  if (passId !== null)
    await run(
      kit.env.DB,
      'UPDATE scans SET pass_id = ?, template_id = ?, action_id = ?, action_kind = ? WHERE id = ?',
      [passId, tpl, 'check_in', kind, id],
    );
  return id;
}

export const gate = (passId: string, scanId: string, scope = '', mode: 'live' | 'test' = 'live') =>
  run(
    kit.env.DB,
    `INSERT INTO scan_gates (pass_id, action_id, scope, org_id, mode, template_id, kind, state, count, first_at, last_at, last_scan_id)
     VALUES (?, 'check_in', ?, ?, ?, ?, 'check_in', 'in', 1, 1, 1, ?)`,
    [passId, scope, kit.org.id, mode, tpl, scanId],
  );

export async function reconcileWithRace(interleave: (db: D1Database) => Promise<void>) {
  let batches = 0;
  const db = new Proxy(kit.env.DB, {
    get(target, prop) {
      if (prop === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          if (++batches === 2) await interleave(target);
          return target.batch(statements);
        };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const env = { ...kit.env, DB: db };
  await reconcileScans(createServiceContext(env, { clock: kit.clock }));
  expect(batches).toBe(2);
}

export async function addPresence(
  db: D1Database,
  passId: string,
  scanId: string,
  reference: 'last' | 'previous',
) {
  await run(
    db,
    `INSERT INTO scan_presence
    (pass_id, org_id, scope, state, tracking, entered_at, first_at, last_entry_at, last_scan_id, prev_scan_id)
    VALUES (?, ?, '', 'in', 1, 1, 1, 1, ?, ?)`,
    [
      passId,
      kit.org.id,
      reference === 'last' ? scanId : 'new-scan',
      reference === 'previous' ? scanId : null,
    ],
  );
}
