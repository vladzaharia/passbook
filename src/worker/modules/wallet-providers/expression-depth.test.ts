// The largest predicates the wallet-provider code emits, prepared on miniflare D1 with their depth and
// term count measured. Local workerd D1 enforces the same expression-depth limit (100) as remote D1, so a
// statement that prepares here prepares there (review-authority-lows.md).
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { Binds } from '../../platform/authority-principal.ts';
import { all } from '../../platform/db.ts';
import { retirementCtes } from './repo-callbacks-tombstone-retirement.ts';
import { PART_CURRENT_OPERATION } from './repo-instance-claim-sql.ts';
import {
  walletOpCurrentCheck,
  walletOpCurrentSql,
  walletOpReadCurrentSql,
} from './repo-instance-current.ts';
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

const CHECK_DEPTH = 36;
const CHECK_TERMS = 55;
const CTE_DEPTH = 30;

describe('expression depth of the largest wallet-provider predicates', () => {
  // Measured when written (the depth is an upper bound): ceilings, so a growing predicate fails here first.
  // CW10b raised three on purpose: a compiled Samsung card (schema 2) bypasses stored evidence with
  // one `OR schema = 2` per evidence predicate (upsert terms 248 -> 252, revoke depth 25 -> 26 and
  // terms 55 -> 56, binding terms 159 -> 162). All stay far below remote D1's limit of 100.
  // 0222 (sole approval for wallet classes) put `approval.kind = 'sole' OR` in front of each independence
  // predicate: revoke depth 26 -> 27 and terms 56 -> 58; the three triggers below grew the same way.
  // 0230 (Samsung system release): the exemption's `provider IN (...)` is one group deeper: revoke depth 27 -> 28.
  // The credential-presence COALESCE (account-presence.ts) put one level on the epoch checks: 24 -> 25, 26 -> 27, 31 -> 32, CTE 25 -> 26.
  // 0229: the revoke identity check also accepts a Samsung enrolment (repo-instance-current.ts), one more `OR`
  // group on the epoch checks: 25 -> 26 and 32 -> 34 terms, 27 -> 28 and 50 -> 52, check 32 -> 33 and 51 -> 53, CTE 26 -> 27. The Samsung revoke identity then compares the partner of the pinned
  // version (L-N2): epoch checks 29/36 and 31/54, check 36/55, CTE 30.
  it.each([
    ['upsert proof', walletInstanceOperationCurrentSql('i', 'op', 'clock.now'), 63, 252],
    ['revoke proof', walletInstanceOperationCurrentSql('i', 'op', 'clock.now', 'revoke'), 28, 58],
    ['release binding', bindingSql, 49, 162],
    ['epoch current (grant part)', walletOpCurrentSql('i', 'op'), 29, 36],
    ['epoch current (read)', walletOpReadCurrentSql('i', 'op'), 31, 54],
  ])(
    '%s prepares on D1 within its measured depth and terms',
    async (_name, predicate, depth, n) => {
      await all(env.DB, harness(predicate), []);
      expect(exprDepth(predicate)).toBeLessThanOrEqual(depth);
      expect(terms(predicate)).toBeLessThanOrEqual(n);
    },
  );

  it('measures the composed grant check and the settle CTE of the epoch queue', async () => {
    const b = new Binds();
    const check = walletOpCurrentCheck('i1', 1).ok(b, 'org_mode');
    await all(
      env.DB,
      `SELECT 1 FROM (SELECT 'o' AS org_id, 'live' AS mode) a WHERE COALESCE((${check}), 0) = 1`,
      b.params,
    );
    expect(exprDepth(check)).toBeLessThanOrEqual(CHECK_DEPTH);
    expect(terms(check)).toBeLessThanOrEqual(CHECK_TERMS);
    expect(exprDepth(PART_CURRENT_OPERATION)).toBeLessThanOrEqual(CTE_DEPTH);
  });

  it('measures every trigger the migrations leave on the projection paths', async () => {
    const triggers = await all<{ name: string; sql: string }>(
      env.DB,
      `SELECT name, sql FROM sqlite_master WHERE type = 'trigger'
       AND name IN ('template_provider_approvals_insert', 'template_approvals_insert',
         'template_provider_releases_insert', 'template_releases_insert', 'wallet_provider_generation_ready_guard',
         'pass_credential_transfer_complete_guard', 'wallet_provider_instances_settle',
         'wallet_samsung_tombstones_approved_insert', 'wallet_samsung_tombstone_keyset_insert',
         'wallet_provider_generation_insert_guard', 'wallet_provider_instances_successor',
         'template_provider_candidates_insert', 'wallet_provider_generation_operation_guard')`,
      [],
    );
    expect(triggers.length).toBe(13);
    const ceiling: Record<string, [number, number]> = {
      wallet_provider_instances_settle: [4, 2],
      wallet_provider_generation_ready_guard: [15, 16],
      pass_credential_transfer_complete_guard: [48, 59],
      template_provider_approvals_insert: [33, 39],
      template_approvals_insert: [18, 26],
      // 0222: the sole recount at release (count and approver) joined the void check: 34/86.
      template_releases_insert: [34, 86],
      // 0199: the schema 2 branch (two evidence bypasses and the card-state row requirement) took the
      // release trigger from 46/113 to 50/131. Remote D1's limit is 100.
      template_provider_releases_insert: [51, 106],
      // 0199: evidence joins became LEFT JOINs under an `OR schema = 2`. 0229: an enrolment account's tombstone is
      // proved by its pinned credential version instead of a configure event (37 -> 46, 33 -> 42, with the account's identity).
      wallet_samsung_tombstones_approved_insert: [46, 42],
      // 0230: one more OR/AND pair for the system exemption: terms 37 -> 39.
      wallet_samsung_tombstone_keyset_insert: [39, 39],
      // 0229 recreated these: the release gate on the insert guard, the epoch pin and enrolment terms on the
      // successor and the candidate, the enrolment On and not held terms on the operation guard.
      wallet_provider_generation_insert_guard: [21, 38],
      template_provider_candidates_insert: [34, 33],
      wallet_provider_instances_successor: [26, 42],
      wallet_provider_generation_operation_guard: [32, 50],
    };
    for (const t of triggers) {
      const [depth, n] = ceiling[t.name] ?? [0, 0];
      expect(exprDepth(t.sql), t.name).toBeLessThanOrEqual(depth);
      expect(terms(t.sql), t.name).toBeLessThanOrEqual(n);
    }
  });
  it('prepares the Samsung retirement CTEs, with the enrolment pin proof, within their measured depth and terms', async () => {
    await all(env.DB, `${retirementCtes} SELECT 1 AS ok FROM retirement_scope retirement`, [
      'i',
      'o',
      'live',
      1,
      'h',
    ]);
    expect(exprDepth(retirementCtes)).toBeLessThanOrEqual(69);
    expect(terms(retirementCtes)).toBeLessThanOrEqual(122);
  });

  it('measures the views 0222 rebuilt: the retirement base and the Apple source', async () => {
    const views = await all<{ name: string; sql: string }>(
      env.DB,
      `SELECT name, sql FROM sqlite_master WHERE type = 'view'
       AND name IN ('wallet_provider_retirement_complete_base', 'template_provider_apple_sources')`,
      [],
    );
    expect(views).toHaveLength(2);
    const ceiling: Record<string, [number, number]> = {
      // 0199 made the evidence optional (33/75); 0222 added the sole approval clause (33/77); 0230 the system
      // exemption (33/79).
      wallet_provider_retirement_complete_base: [33, 79],
      template_provider_apple_sources: [37, 41],
    };
    for (const v of views) {
      const [depth, n] = ceiling[v.name] ?? [0, 0];
      expect(exprDepth(v.sql), v.name).toBeLessThanOrEqual(depth);
      expect(terms(v.sql), v.name).toBeLessThanOrEqual(n);
    }
  });
});
