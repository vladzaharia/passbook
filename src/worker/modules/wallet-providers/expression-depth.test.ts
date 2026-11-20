// The largest predicates the wallet-provider code emits, prepared on miniflare D1 with their depth and
// term count measured. D1's own limit is lower than the local engine's: the remote check stays an
// owner or deploy-time item (review-wa6a-merge.md, open question).
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { all } from '../../platform/db.ts';
import { walletInstanceOperationCurrentSql } from './repo-instance-proof.ts';
import { projectionReleaseBindingPredicateSql } from './repo-projection.ts';

/**
 * An upper bound of the expression tree depth. SQLite parses `a AND b AND c` as a left-deep tree, so a
 * chain of n operators at one level is n deep; a parenthesised group or subquery nests below its level.
 */
function exprDepth(sql: string): number {
  const text = sql.replace(/--[^\n]*/g, '').replace(/'(?:[^']|'')*'/g, "''");
  const stack: { ops: number; child: number }[] = [{ ops: 0, child: 0 }];
  for (const token of text.matchAll(/\(|\)|\b(?:AND|OR)\b/gi)) {
    const top = stack[stack.length - 1];
    if (!top) break;
    if (token[0] === '(') stack.push({ ops: 0, child: 0 });
    else if (token[0] === ')') {
      const done = stack.pop();
      const parent = stack[stack.length - 1];
      if (done && parent) {
        const d = 1 + done.ops + done.child;
        parent.child = Math.max(parent.child, d);
      }
    } else top.ops += 1;
  }
  const root = stack[0];
  return root ? 1 + root.ops + root.child : 0;
}
const terms = (sql: string) => (sql.match(/\b(?:AND|OR)\b/gi) ?? []).length;

const harness = (predicate: string) =>
  `SELECT 1 FROM wallet_provider_instances i
   JOIN wallet_provider_instance_operations op ON op.instance_id = i.id
   JOIN passes p ON p.id = i.pass_id
   CROSS JOIN (SELECT 1 AS now, 1 AS now_ms) clock
   WHERE ${predicate} LIMIT 1`;

const bindingSql = projectionReleaseBindingPredicateSql({
  releaseIdSql: 'op.projection_release_id',
  orgIdSql: 'i.org_id',
  modeSql: 'i.mode',
  providerSql: 'i.provider',
  templateIdSql: 'p.template_id',
  versionSql: 'p.template_version',
  sourceReleaseIdSql: 'p.release_id',
  nowSql: 'clock.now',
  credentialKeysetCommitmentSql: 'op.credential_keyset_commitment',
});

describe('expression depth of the largest wallet-provider predicates', () => {
  // Measured when written (the depth is an upper bound): ceilings, so a growing predicate fails here first.
  it.each([
    ['upsert proof', walletInstanceOperationCurrentSql('i', 'op', 'clock.now'), 63, 248],
    ['revoke proof', walletInstanceOperationCurrentSql('i', 'op', 'clock.now', 'revoke'), 25, 55],
    ['release binding', bindingSql, 49, 159],
  ])(
    '%s prepares on D1 within its measured depth and terms',
    async (_name, predicate, depth, n) => {
      await all(env.DB, harness(predicate), []);
      expect(exprDepth(predicate)).toBeLessThanOrEqual(depth);
      expect(terms(predicate)).toBeLessThanOrEqual(n);
    },
  );

  it('measures every trigger the migrations leave on the projection paths', async () => {
    const triggers = await all<{ name: string; sql: string }>(
      env.DB,
      `SELECT name, sql FROM sqlite_master WHERE type = 'trigger'
       AND name IN ('template_provider_approvals_insert', 'template_approvals_insert',
         'template_provider_releases_insert', 'wallet_provider_generation_ready_guard',
         'pass_credential_transfer_complete_guard', 'wallet_provider_instances_settle')`,
      [],
    );
    expect(triggers.length).toBe(6);
    const ceiling: Record<string, [number, number]> = {
      wallet_provider_instances_settle: [4, 2],
      wallet_provider_generation_ready_guard: [15, 16],
      pass_credential_transfer_complete_guard: [48, 59],
      template_provider_approvals_insert: [33, 37],
      template_approvals_insert: [19, 29],
      template_provider_releases_insert: [46, 113],
    };
    for (const t of triggers) {
      const [depth, n] = ceiling[t.name] ?? [0, 0];
      expect(exprDepth(t.sql), t.name).toBeLessThanOrEqual(depth);
      expect(terms(t.sql), t.name).toBeLessThanOrEqual(n);
    }
  });
});
