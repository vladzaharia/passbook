import type { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { runOne } from '../../../../test/helpers/exact-rows.ts';
import {
  type makeEnv,
  makeOrg,
  makePass,
  makeScanner,
  makeTemplate,
} from '../../../../test/helpers/index.ts';
import { type Grant, grant } from '../../platform/authority.ts';
import type { AppBindings } from '../../platform/context.ts';
import { all, first } from '../../platform/db.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { scanActorChecks, scanPrincipal } from './authority-checks.ts';
import { createGuardHarness, get } from './guard-test-fixtures.ts';
import { scanPassChecks } from './scan-pass-checks.ts';
import { startScanCredentialTransfer } from './test-kit.ts';

const harness = createGuardHarness();
let { f, clock, orgId } = harness;
const build: typeof harness.build = async (...args) => {
  const result = await harness.build(...args);
  ({ f, clock, orgId } = harness);
  return result;
};

const CODES = { lineage: 'SCAN_PASS_CHANGED', config: 'SCAN_CONFIG_CHANGED' };

/**
 * The scan write path on the grant builder: one grant per attempt, the gate written by compare and
 * swap against the row the preflight observed. Losers are definite, classified refusals, so the
 * caller can re-read and answer `already_done` instead of guessing.
 */
describe('scan gate writes through a grant', () => {
  let app: Hono<AppBindings>;
  let env: Awaited<ReturnType<typeof makeEnv>>;
  beforeEach(async () => {
    ({ app, env } = await build());
  });

  async function setup() {
    const template = makeTemplate({ id: f.ids.id(), orgId });
    await harness.persistApprovedTemplate(template);
    const code = `GATE-${f.ids.token(8)}`;
    const pass = await makePass(f, { orgId, template: template.resolved, scanCode: code });
    const scanner = await makeScanner(f, { orgId });
    expect((await get(app, env, '/capture-read', scanner.headers)).status).toBe(200);
    const actor = harness.capturedActor;
    if (!actor) throw new Error('no actor');
    const observed = async () => {
      const r = await first<{
        status: 'active' | 'voided';
        removed_at: number | null;
        credential_generation: number;
        lifecycle_generation: number;
        template_id: string;
        test_data_quarantined: number;
      }>(env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id]);
      if (!r) throw new Error('no pass');
      return {
        status: r.status,
        removedAt: r.removed_at,
        credentialGeneration: r.credential_generation,
        lifecycleGeneration: r.lifecycle_generation,
        templateId: r.template_id,
        testDataQuarantined: r.test_data_quarantined !== 0,
      };
    };
    const claim = async (id: string) =>
      runOne(
        env.DB,
        `INSERT INTO scans (id, org_id, mode, scanner_id, actor_type, actor_id, actor_key, idempotency_key,
           request_hash, method, state, at)
         VALUES (?, ?, 'live', ?, 'scanner', ?, ?, ?, 'h', 'camera', 'pending', ?)`,
        [id, orgId, actor.scanner?.id ?? '', actor.actor.id, actor.actorKey, id, clock.now()],
      );
    const attempt = (
      scanId: string,
      seen: Awaited<ReturnType<typeof observed>>,
      before: string | null,
      credential: Record<string, string> = { scan_code: code },
    ): Grant => {
      const g = grant(createServiceContext(env, { clock }), {
        purpose: 'org_mode.scan.check_in',
        principal: scanPrincipal(actor),
        checks: [
          ...scanActorChecks(actor, { now: clock.now(), templateId: template.resolved.id }),
          ...scanPassChecks(pass.id, { pass: seen, credential }),
        ],
        codes: CODES,
      });
      const scope = '';
      if (before === null)
        g.insertSelect(
          'scan_gates',
          [
            'pass_id',
            'action_id',
            'scope',
            'template_id',
            'kind',
            'state',
            'count',
            'first_at',
            'last_at',
            'last_scan_id',
          ],
          [pass.id, 'checkin', scope, template.resolved.id, 'check_in', 'in', 1, 1, 1, scanId],
        );
      else
        g.update('scan_gates', {
          set: {
            prev_state: 'in',
            prev_last_at: 1,
            prev_scan_id: before,
            state: 'in',
            last_at: 2,
            last_scan_id: scanId,
          },
          inc: ['count'],
          where: { pass_id: pass.id, action_id: 'checkin', scope, last_scan_id: before },
          require: 'one',
          returning: ['last_scan_id'],
        });
      g.update('scans', {
        set: { state: 'done', outcome: 'ok', pass_id: pass.id, template_id: template.resolved.id },
        where: { id: scanId, state: 'pending', at: clock.now() },
        require: 'one',
        returning: ['id'],
      });
      return g;
    };
    const outcome = (g: Grant) =>
      g.commit().then(
        () => 'ok' as const,
        (e: { status?: number; code?: string; message?: string }) =>
          e.status ? ([e.status, e.code] as [number, string | undefined]) : `raw: ${e.message}`,
      );
    return { template, pass, actor, observed, claim, attempt, outcome };
  }

  const gate = (env: Awaited<ReturnType<typeof makeEnv>>, passId: string) =>
    all<{ last_scan_id: string; count: number; prev_scan_id: string | null }>(
      env.DB,
      'SELECT last_scan_id, count, prev_scan_id FROM scan_gates WHERE pass_id = ?',
      [passId],
    );

  describe('liveness', () => {
    it('10 scanners racing for one gate: one wins, nine get a definite refusal to re-read', async () => {
      const s = await setup();
      const seen = await s.observed();
      const ids = Array.from({ length: 10 }, (_, i) => `race-${i}`);
      for (const id of ids) await s.claim(id);
      const results = await Promise.all(ids.map((id) => s.outcome(s.attempt(id, seen, null))));
      expect(results.filter((r) => r === 'ok')).toHaveLength(1);
      // The nine losers abort the whole batch: a UNIQUE violation on the insert, nothing half-written.
      const losers = results.filter((r) => r !== 'ok');
      expect(losers).toHaveLength(9);
      expect(losers.every((r) => typeof r === 'string' && r.startsWith('raw:'))).toBe(true);
      expect(losers.every((r) => /UNIQUE|constraint/i.test(String(r)))).toBe(true);
      const rows = await gate(env, s.pass.id);
      expect(rows).toHaveLength(1);
      const done = await all<{ id: string }>(env.DB, "SELECT id FROM scans WHERE state = 'done'");
      expect(done.map((r) => r.id)).toEqual([rows[0]?.last_scan_id]);
    });

    it('a second scan after the first is a CAS on the observed holder; a stale CAS is refused', async () => {
      const s = await setup();
      await s.claim('first');
      expect(await s.outcome(s.attempt('first', await s.observed(), null))).toBe('ok');
      await s.claim('second');
      await s.claim('third');
      const seen = await s.observed();
      const results = await Promise.all([
        s.outcome(s.attempt('second', seen, 'first')),
        s.outcome(s.attempt('third', seen, 'first')),
      ]);
      expect(results.filter((r) => r === 'ok')).toHaveLength(1);
      expect(results.filter((r) => Array.isArray(r))).toEqual([[409, 'SCAN_PASS_CHANGED']]);
      const rows = await gate(env, s.pass.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.count).toBe(2);
      expect(rows[0]?.prev_scan_id).toBe('first');
    });
  });

  describe('safety', () => {
    it('a void between preflight and commit is refused', async () => {
      const s = await setup();
      await s.claim('v1');
      const seen = await s.observed();
      await runOne(env.DB, "UPDATE passes SET status = 'voided' WHERE id = ?", [s.pass.id]);
      expect(await s.outcome(s.attempt('v1', seen, null))).toEqual([409, 'SCAN_PASS_CHANGED']);
      expect(await gate(env, s.pass.id)).toEqual([]);
    });

    it('a transfer started between preflight and commit is refused', async () => {
      const s = await setup();
      await s.claim('t1');
      const seen = await s.observed();
      await startScanCredentialTransfer({ ctx: createServiceContext(env, { clock }) }, s.pass.id);
      expect(await s.outcome(s.attempt('t1', seen, null))).toEqual([409, 'SCAN_PASS_CHANGED']);
      expect(await gate(env, s.pass.id)).toEqual([]);
    });

    it('a barcode replaced by a publish (hash rewritten, no generation) is refused', async () => {
      const s = await setup();
      await runOne(
        env.DB,
        "UPDATE passes SET barcode_hash = 'hash-1', version = version + 1 WHERE id = ?",
        [s.pass.id],
      );
      await s.claim('b1');
      const seen = await s.observed();
      const g = s.attempt('b1', seen, null, { barcode_hash: 'hash-1' });
      await runOne(
        env.DB,
        "UPDATE passes SET barcode_hash = 'hash-2', version = version + 1 WHERE id = ?",
        [s.pass.id],
      );
      expect(await s.outcome(g)).toEqual([409, 'SCAN_PASS_CHANGED']);
      expect(await gate(env, s.pass.id)).toEqual([]);
    });

    it('a template reassigned to another org is refused', async () => {
      const s = await setup();
      await s.claim('r1');
      const seen = await s.observed();
      const other = await makeOrg(f);
      await runOne(env.DB, 'UPDATE templates SET org_id = ? WHERE id = ?', [
        other.id,
        s.template.resolved.id,
      ]);
      expect(await s.outcome(s.attempt('r1', seen, null))).toEqual([409, 'SCAN_PASS_CHANGED']);
    });

    it('a sync touching volatile pass columns does not refuse the scan', async () => {
      const s = await setup();
      await s.claim('ok1');
      const seen = await s.observed();
      await runOne(
        env.DB,
        'UPDATE passes SET last_synced_at = ?, content_hash = ?, next_sync_at = ? WHERE id = ?',
        [clock.now(), 'sync', clock.now() + 60_000, s.pass.id],
      );
      expect(await s.outcome(s.attempt('ok1', seen, null))).toBe('ok');
    });
  });
});
