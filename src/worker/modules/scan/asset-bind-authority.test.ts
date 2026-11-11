import { beforeAll, describe, expect, it } from 'vitest';
import { countD1 } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { actorCsrfAuthorityStmt, actorCsrfSnapshotFromResult } from './actor-csrf.ts';
import { build, fixture, planFor } from './asset-bind-authority-scenarios-test-fixtures.ts';
import { grantInsertConfirmed } from './asset-grant-results.ts';
import { confirmAssetGrantToken } from './assets.ts';
import { stored } from './repo-asset-bind-authority-test-fixtures.ts';
import { prepareAssetGrantInsertion } from './repo-asset-grants.ts';
import { type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;

beforeAll(async () => {
  kit = await setupScanKit();
  await ensureCredentialRefKeyset(kit.env.DB, kit.env);
});

describe('asset grant D1 bind budget authority', () => {
  it.each([true, false])(
    'batches multiple output fences with atomic effects (allowed: %s)',
    async (allowed) => {
      const f = await fixture(kit);
      const plan = await planFor(kit, f, 'admin');
      const predicates = [
        { sql: 'p.id=?/* scan-ephemeral-pass-id */', params: [f.candidate.pass.id] },
        {
          sql: 'scope.id=?/* scan-ephemeral-pass-id */',
          params: [allowed ? f.candidate.pass.id : 'different'],
        },
      ];
      const { statements, bindings } = await build(kit, plan, f.candidate, predicates);
      const outputBindings = bindings.slice(-2);
      expect(outputBindings[0]!.sql).toContain('p.id=');
      expect(outputBindings[1]!.sql).toContain('scope.id=');
      for (const bound of bindings) expect(bound.params.length).toBeLessThan(100);
      const effect = kit.env.DB.prepare('UPDATE users SET primary_email = ? WHERE id = ?').bind(
        'batch-effect@example.test',
        f.user.id,
      );
      if (allowed) {
        const [, ...results] = await kit.env.DB.batch<Record<string, unknown>>([
          effect,
          ...statements,
        ]);
        expect(results.slice(-2).map((result) => result.results?.[0]?.authorized)).toEqual([1, 1]);
        expect(grantInsertConfirmed(results)).toBe(true);
        expect(confirmAssetGrantToken(plan, results)).toMatch(/^[A-Za-z0-9_-]{54}$/);
        expect(await stored(kit, plan)).not.toBeNull();
      } else {
        await expect(kit.env.DB.batch([effect, ...statements])).rejects.toThrow(
          /scan_asset_authority_failed/,
        );
        expect(confirmAssetGrantToken(plan, undefined)).toBeNull();
        expect(await stored(kit, plan)).toBeNull();
        expect(
          await first(kit.env.DB, 'SELECT primary_email FROM users WHERE id = ?', [f.user.id]),
        ).toEqual({ primary_email: f.user.primaryEmail });
      }
    },
  );

  it('reuses preloaded recipient and source CSRF snapshots without weakening the final fence', async () => {
    const f = await fixture(kit);
    const recipientStmt = actorCsrfAuthorityStmt(kit.env.DB, f.admin);
    const sourceStmt = actorCsrfAuthorityStmt(kit.env.DB, f.source.actor);
    if (!recipientStmt || !sourceStmt) throw new Error('Missing actor CSRF query');
    const [recipientResult, sourceResult] = await kit.env.DB.batch([recipientStmt, sourceStmt]);
    const [recipientSnapshot, sourceSnapshot] = await Promise.all([
      actorCsrfSnapshotFromResult(kit.ctx, f.admin, recipientResult),
      actorCsrfSnapshotFromResult(kit.ctx, f.source.actor, sourceResult),
    ]);
    if (!recipientSnapshot || !sourceSnapshot) throw new Error('Missing actor CSRF snapshots');
    const counted = countD1(kit.env.DB);
    const ctx = { ...kit.ctx, env: { ...kit.ctx.env, DB: counted.db } };
    const plan = await planFor(kit, f, 'admin');
    const bind = await prepareAssetGrantInsertion(
      ctx,
      plan,
      { recipientSnapshot, sourceSnapshot },
      f.candidate,
    );
    const statements = bind(ctx.clock.now(), undefined);
    expect(counted.count()).toBe(0);
    expect(grantInsertConfirmed(await counted.db.batch(statements))).toBe(true);
    expect(counted.count()).toBe(1);

    const stale = await planFor(kit, f, 'admin');
    const staleBind = await prepareAssetGrantInsertion(
      ctx,
      stale,
      { recipientSnapshot, sourceSnapshot },
      f.candidate,
    );
    const staleStatements = staleBind(ctx.clock.now(), undefined);
    await run(
      kit.env.DB,
      'UPDATE scanners SET csrf_secret = ?, updated_at = updated_at + 1 WHERE id = ?',
      ['changed', f.sourceDevice.id],
    );
    await expect(counted.db.batch(staleStatements)).rejects.toThrow(/scan_asset_authority_failed/);
    expect(await stored(kit, stale)).toBeNull();
  });
});
