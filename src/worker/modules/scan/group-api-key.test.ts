import { beforeAll, expect, it } from 'vitest';
import { ScanOutcomeSchema } from '../../../shared/contracts/scan.ts';
import { first, run } from '../../platform/db.ts';
import { key, setupTillKit } from './guard-api-key-test-fixtures.ts';

let t: Awaited<ReturnType<typeof setupTillKit>>;
beforeAll(async () => {
  t = await setupTillKit();
});

it('a scans:write key admits and undoes a whole bundle as its terminal', async () => {
  const kit = t.kit;
  const k = await t.till();
  const passes = [await kit.scanPass(t.templateId), await kit.scanPass(t.templateId)];
  const bundleId = kit.fx.ids.id();
  await run(
    kit.env.DB,
    "INSERT INTO bundles (id, org_id, name, token, created_at) VALUES (?, ?, 'Family', ?, 1)",
    [bundleId, kit.org.id, `h1:${kit.fx.ids.token()}`],
  );
  for (const [i, p] of passes.entries())
    await run(kit.env.DB, 'INSERT INTO bundle_passes VALUES (?, ?, ?)', [bundleId, p.id, i]);
  const res = await t.call(
    k.headers,
    '/actions',
    t.request((passes[0] as { id: string }).id, { group: 'bundle' }),
  );
  expect(res.status).toBe(200);
  const o = ScanOutcomeSchema.parse(await res.json());
  expect(o.group).toMatchObject({ total: 2, done: 2 });
  const rows = await first<{ n: number }>(
    kit.env.DB,
    'SELECT COUNT(*) n FROM scans WHERE api_key_id = ? AND outcome = ?',
    [k.apiKey.id, 'ok'],
  );
  expect(rows?.n).toBe(2);
  const undone = await t.call(k.headers, `/scans/${o.scanId}/undo`, { idempotencyKey: key() });
  expect(undone.status).toBe(200);
  expect(
    (
      await first<{ n: number }>(
        kit.env.DB,
        'SELECT COUNT(*) n FROM scans WHERE undone_by IS NOT NULL AND api_key_id = ?',
        [k.apiKey.id],
      )
    )?.n,
  ).toBe(2);
});
