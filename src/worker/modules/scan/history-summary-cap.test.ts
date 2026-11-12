import { describe, expect, it } from 'vitest';
import { makePass, makeTemplate } from '../../../../test/helpers/index.ts';
import { ScanSummarySchema } from '../../../shared/contracts/scan-session.ts';
import { run } from '../../platform/db.ts';
import { setupScanKit } from './test-kit.ts';

type Kit = Awaited<ReturnType<typeof setupScanKit>>;

/** Successful check-ins of one pass by one scanner within the last day. */
async function seedScans(kit: Kit, scannerId: string, n: number) {
  const template = makeTemplate({ id: kit.fx.ids.id(), orgId: kit.org.id });
  const pass = await makePass(kit.fx, { orgId: kit.org.id, template: template.resolved });
  const prefix = `${scannerId}-summary-`;
  await run(
    kit.env.DB,
    `WITH RECURSIVE seq(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM seq WHERE n + 1 < ?)
     INSERT INTO scans (id,org_id,mode,pass_id,template_id,scanner_id,actor_type,actor_id,actor_key,
       idempotency_key,request_hash,method,state,outcome,action_id,action_kind,at)
     SELECT ? || printf('%04d', n), ?, 'live', ?, NULL, ?, 'scanner', ?, ?, ? || n, ? || n,
       'camera', 'done', 'ok', 'check_in', 'check_in', ?
     FROM seq`,
    [
      n,
      prefix,
      kit.org.id,
      pass.id,
      scannerId,
      scannerId,
      `s:${scannerId}`,
      prefix,
      prefix,
      kit.clock.now() - 60_000,
    ],
  );
}

/** Count the summary's contributor page reads while it answers. */
async function summaryReads(kit: Kit, headers: Record<string, string>) {
  const real = kit.env.DB;
  let reads = 0;
  const watch = (statement: D1PreparedStatement, page: boolean): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, member) {
        if (member === 'bind') return (...values: unknown[]) => watch(target.bind(...values), page);
        if (member === 'all' && page) reads++;
        const value = Reflect.get(target, member, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  const counted = new Proxy(real, {
    get(target, property) {
      if (property === 'prepare')
        return (sql: string) =>
          watch(target.prepare(sql), /AS projection_authorized/.test(sql) && /LIMIT 100/.test(sql));
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  Object.assign(kit.env, { DB: counted });
  try {
    const response = await kit.get(headers, '/summary');
    expect(response.status).toBe(200);
    return { reads, summary: ScanSummarySchema.parse(await response.json()) };
  } finally {
    Object.assign(kit.env, { DB: real });
  }
}

describe('GET /scan/summary page cap', () => {
  it('verifies at most five contributor pages, keeps exact totals and lists no actions past the cap', async () => {
    const kit = await setupScanKit();
    // Control: under the cap every page is read.
    const small = await kit.scanner();
    await seedScans(kit, small.id, 150);
    const under = await summaryReads(kit, small.headers);
    expect(under.reads).toBe(2);
    expect(under.summary).toMatchObject({ total: 150, ok: 150 });

    const busy = await kit.scanner();
    await seedScans(kit, busy.id, 650);
    const capped = await summaryReads(kit, busy.headers);
    expect(capped.reads).toBe(5);
    expect(capped.summary).toMatchObject({ total: 650, ok: 650, byAction: [] });
  });
});
