import { beforeAll, describe, expect, it } from 'vitest';
import type { Mode } from '../../../shared/contracts/common.ts';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import {
  historyProofSnapshotsForOrg,
  historyProofSnapshotsForScopes,
  type VerifiedHistoryProof,
} from './history-proof.ts';
import { planHistoryProofSnapshotsForOrg } from './history-proof-plan.ts';
import { codeOf, key, type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
let credentialKeysetCommitment: string;
beforeAll(async () => {
  kit = await setupScanKit();
  credentialKeysetCommitment = await ensureCredentialRefKeyset(kit.env.DB, kit.env);
});

describe('history proof batch scope', () => {
  it('captures every tenant, mode and scan tuple before the first asynchronous page', async () => {
    const scopes: { orgId: string; mode: Mode; scanId: string }[] = Array.from(
      { length: 101 },
      (_, index) => ({
        orgId: kit.org.id,
        mode: 'live',
        scanId: `missing-${index}`,
      }),
    );
    const original = { ...scopes[100]! };
    const binds: unknown[][] = [];
    const db = new Proxy(kit.env.DB, {
      get(target, property) {
        if (property === 'prepare')
          return (sql: string) => {
            const prepared = target.prepare(sql);
            if (!sql.startsWith('WITH ids(id) AS (VALUES ')) return prepared;
            return new Proxy(prepared, {
              get(statement, member) {
                if (member === 'bind')
                  return (...values: unknown[]) => {
                    binds.push(values);
                    return statement.bind(...values);
                  };
                const value = Reflect.get(statement, member, statement);
                return typeof value === 'function' ? value.bind(statement) : value;
              },
            });
          };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const ctx = createServiceContext({ ...kit.env, DB: db }, { clock: kit.clock });
    const pending = historyProofSnapshotsForScopes(
      ctx,
      scopes,
      new Map(),
      credentialKeysetCommitment,
    );
    scopes[100]!.orgId = 'foreign-org';
    scopes[100]!.mode = 'test';
    scopes[100]!.scanId = 'foreign-scan';
    expect((await pending).size).toBe(0);
    expect(binds).toHaveLength(6);
    expect(binds.every((values) => values.length <= 100)).toBe(true);
    expect(binds[5]).toEqual([
      original.scanId,
      kit.clock.now(),
      original.orgId,
      original.mode,
      original.scanId,
      credentialKeysetCommitment,
    ]);
  });

  it('does not return a cached proof for an ID added after the read starts', async () => {
    const template = await kit.scanTemplate('Captured history IDs', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
    });
    const scanner = await kit.scanner({ templateIds: [template] });
    const pass = await kit.scanPass(template);
    const response = await kit.post(scanner.headers, '/actions', {
      input: codeOf(pass),
      idempotencyKey: key(),
      clientTs: kit.clock.now(),
      actionId: 'check_in',
    });
    expect(response.status).toBe(200);
    const { scanId } = (await response.json()) as ScanOutcome;
    if (!scanId) throw new Error('Missing scan ID');
    const scope = { orgId: kit.org.id, mode: 'live' as const, credentialKeysetCommitment };
    const cache = new Map<string, VerifiedHistoryProof | null>();
    expect((await historyProofSnapshotsForOrg(kit.ctx, scope, [scanId], cache)).has(scanId)).toBe(
      true,
    );
    expect(
      [...cache.keys()].every((key) => /^[0-9a-f]{64}$/.test(key) && !key.includes(scanId)),
    ).toBe(true);
    const plannedIds = [scanId];
    const plan = planHistoryProofSnapshotsForOrg(kit.ctx, scope, plannedIds);
    plannedIds[0] = 'foreign-scan';
    expect(plan.stmts).toHaveLength(1);
    const results = await kit.env.DB.batch(plan.stmts);
    expect((await plan.finish(results)).has(scanId)).toBe(true);
    expect((await plan.finish(results)).size).toBe(0);
    const missing = planHistoryProofSnapshotsForOrg(kit.ctx, scope, [scanId]);
    expect((await missing.finish([])).size).toBe(0);
    const ids = ['missing-scan'];
    const pending = historyProofSnapshotsForOrg(kit.ctx, scope, ids, cache);
    ids.push(scanId);
    expect((await pending).size).toBe(0);
  });
});
