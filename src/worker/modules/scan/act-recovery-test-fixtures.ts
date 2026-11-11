import { expect } from 'vitest';
import { createServiceContext } from '../../platform/service-context.ts';
import { requestHashOf } from './act-claim.ts';
import { kit } from './act-test-fixtures.ts';
import { reconcileScans } from './jobs.ts';
import { claimScan } from './repo-scans.ts';

export async function stage(
  s: { id: string },
  pass: { scanCode: string | null },
  idempotencyKey: string,
  mode: 'live' | 'test' = 'live',
) {
  const req = {
    idempotencyKey,
    input: { code: pass.scanCode ?? '', method: 'camera' as const },
    clientTs: kit.clock.now(),
    actionId: 'auto',
  };
  await claimScan(kit.env.DB, {
    id: kit.fx.ids.id(),
    orgId: kit.org.id,
    mode,
    scannerId: s.id,
    eventId: null,
    actorType: 'scanner',
    actorId: s.id,
    actorKey: `s:${s.id}`,
    staffId: null,
    idempotencyKey,
    requestHash: await requestHashOf(req),
    method: 'camera',
    clientTs: req.clientTs,
    now: kit.clock.now(),
  });
  return req;
}

export async function cronWithInterleave(interleave: () => Promise<void>) {
  let batches = 0;
  const db = new Proxy(kit.env.DB, {
    get(target, prop) {
      if (prop === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          if (++batches === 2) await interleave();
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
