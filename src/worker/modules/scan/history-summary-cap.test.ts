import { describe, expect, it } from 'vitest';
import { makePass, makeTemplate } from '../../../../test/helpers/index.ts';
import { ScanSummarySchema } from '../../../shared/contracts/scan-session.ts';
import { run } from '../../platform/db.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { RACE_HISTORY_PAGE } from './race-tags.ts';
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

/** The summary's contributor reads: the batches holding the page statement, and the page limit it bound. */
async function summaryReads(kit: Kit, headers: Record<string, string>) {
  const real = kit.env.DB;
  const bound = new WeakMap<object, { sql: string; params: unknown[] }>();
  const reads: number[] = [];
  const counted = new Proxy(real, {
    get(target, property) {
      if (property === 'prepare')
        return (sql: string) =>
          new Proxy(target.prepare(sql), {
            get(inner, member) {
              if (member === 'bind')
                return (...params: unknown[]) => {
                  const statement = inner.bind(...params);
                  bound.set(statement, { sql, params });
                  return statement;
                };
              const value = Reflect.get(inner, member, inner);
              return typeof value === 'function' ? value.bind(inner) : value;
            },
          });
      if (property === 'batch')
        return (statements: D1PreparedStatement[]) => {
          for (const statement of statements) {
            const entry = bound.get(statement);
            if (entry?.sql.includes(RACE_HISTORY_PAGE) && /s\.undone_by IS NULL/.test(entry.sql))
              reads.push(Number(entry.params.at(-2)));
          }
          return target.batch(statements);
        };
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

describe('GET /scan/summary contributor cap', () => {
  it('reads its contributors in one statement of at most 501, and keeps exact totals past the cap', async () => {
    const kit = await setupScanKit();
    // Scans of a pass exist only after an act initialized the credential keyset.
    await ensureCredentialRefKeyset(kit.env.DB, kit.env);
    // Control: under the cap one statement carries every contributor.
    const small = await kit.scanner();
    await seedScans(kit, small.id, 150);
    const under = await summaryReads(kit, small.headers);
    expect(under.reads).toEqual([501]);
    expect(under.summary).toMatchObject({ total: 150, ok: 150 });

    const busy = await kit.scanner();
    await seedScans(kit, busy.id, 650);
    const capped = await summaryReads(kit, busy.headers);
    expect(capped.reads).toEqual([501]);
    expect(capped.summary).toMatchObject({ total: 650, ok: 650, byAction: [] });
  });
});
