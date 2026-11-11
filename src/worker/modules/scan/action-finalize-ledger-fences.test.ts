import { beforeAll, describe, expect, it } from 'vitest';
import { persistTemplate } from '../../../../test/helpers/index.ts';
import { first, run, stmt } from '../../platform/db.ts';
import { ICON_PNG } from '../passes/pass-test-fixtures.ts';
import {
  type ActionRequest,
  effects,
  request,
  type Scenario,
  type Suite,
  scenario,
  send,
  signed,
  suite,
} from './action-gate-stale-budget-core-test-fixtures.ts';
import { key, makeLegacyScanPass } from './test-kit.ts';

let base: Suite;
beforeAll(async () => {
  base = await suite();
});

type Boundary = 'finalize' | 'ledger';
type Change = 'scanner authority' | 'Wallet snapshot' | 'template extras' | 'credential keyset';

/** Put a real one-row mutation between effect statements in the same D1 transaction. */
async function raceAtBoundary(
  s: Scenario,
  boundary: Boundary,
  mutation: D1PreparedStatement,
  body: ActionRequest,
) {
  const real = s.kit.env.DB;
  const finalizes = new WeakSet<D1PreparedStatement>();
  const ledgers = new WeakSet<D1PreparedStatement>();
  let fired = false;
  let failure = '';
  const db = new Proxy(real, {
    get(target, prop) {
      if (prop === 'prepare')
        return (sql: string) => {
          const prepared = target.prepare(sql);
          const tracked = sql.includes("UPDATE scans SET state = 'done'")
            ? finalizes
            : sql.includes('INSERT INTO pass_events')
              ? ledgers
              : null;
          if (!tracked) return prepared;
          return new Proxy(prepared, {
            get(statement, member) {
              if (member === 'bind')
                return (...values: unknown[]) => {
                  const bound = statement.bind(...values);
                  tracked.add(bound);
                  return bound;
                };
              const value = Reflect.get(statement, member, statement);
              return typeof value === 'function' ? value.bind(statement) : value;
            },
          });
        };
      if (prop === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          if (
            fired ||
            !statements.some((statement) => finalizes.has(statement)) ||
            !statements.some((statement) => ledgers.has(statement))
          )
            return target.batch(statements);
          const selected = boundary === 'finalize' ? finalizes : ledgers;
          const index = statements.findIndex((statement) => selected.has(statement));
          if (index < 0) throw new Error('Missing effect boundary');
          fired = true;
          // SELECTs leave changes() untouched. These distinguish a rejected write from a
          // mutation that never applied, or a later check that merely hid a bad write.
          const changed = target.prepare(`SELECT CASE WHEN changes()=1 THEN 1
            ELSE json_extract('[]', '$[injected_change_missing]') END`);
          const rejected = target.prepare(`SELECT CASE WHEN changes()=0 THEN 1
            ELSE json_extract('[]', '$[effect_fence_bypassed]') END`);
          try {
            const results = await target.batch([
              ...statements.slice(0, index),
              mutation,
              changed,
              statements[index]!,
              rejected,
              ...statements.slice(index + 1),
            ]);
            return [...results.slice(0, index), results[index + 2]!, ...results.slice(index + 4)];
          } catch (error) {
            failure = error instanceof Error ? error.message : String(error);
            throw error;
          }
        };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  Object.assign(s.kit.env, { DB: db });
  try {
    const outcome = await send(s, body);
    expect(fired).toBe(true);
    // The injected mutation applied and this exact write rejected it; the real effect
    // assertion then aborted the transaction, rather than committing incomplete proof.
    expect(failure).toContain('scan_effect_incomplete');
    return outcome;
  } finally {
    Object.assign(s.kit.env, { DB: real });
  }
}

/** An unsealed old baked version lets an extra appear without changing release policy. */
async function legacyExtraScenario(): Promise<Scenario> {
  const { kit } = base;
  const source = await kit.registry.resolve(base.template, 'v1');
  const template = kit.registry.add({
    id: `legacy-fence-${key()}`,
    orgId: null,
    origin: 'baked',
    version: 'v1',
    manifest: source.manifest,
    passJson: source.passJson,
    assets: { 'icon.png': ICON_PNG },
  });
  await persistTemplate(kit.fx, template, { registry: kit.registry });
  const pass = await makeLegacyScanPass(kit.fx, {
    orgId: kit.org.id,
    template,
    personalization: { memberName: 'Private budget member' },
  });
  const scanner = await kit.scanner({ templateIds: [template.id] });
  const manager = await kit.staff('manager');
  return {
    kit,
    template: template.id,
    event: null,
    scanner,
    manager,
    pass,
    managed: null,
    post: (body) => kit.post(scanner.headers, '/actions', body),
  };
}

describe('check-in finalize and ledger fences', () => {
  it.each(['released', 'legacy'] as const)(
    'commits the unchanged %s candidate with its signed ledger and retention proof',
    async (kind) => {
      const s =
        kind === 'legacy'
          ? await legacyExtraScenario()
          : await scenario(base, { event: true, tracked: true, photo: true });
      const outcome = await send(s);
      expect(outcome).toMatchObject({ kind: 'ok', scanId: expect.any(String) });
      if (!outcome.scanId) throw new Error('Missing finalized check-in');
      await signed(s, outcome.scanId);
      const committed = await effects(s.kit.env.DB, s);
      expect(committed.gates).toHaveLength(1);
      expect(committed.scans).toHaveLength(1);
      expect(committed.events).toHaveLength(1);
      expect(committed.retention).toHaveLength(1);
    },
  );

  for (const boundary of ['finalize', 'ledger'] as const) {
    it.each([
      'scanner authority',
      'Wallet snapshot',
      'template extras',
      'credential keyset',
    ] as const)('rejects changed %s immediately before ' + boundary, async (change: Change) => {
      const s =
        change === 'template extras'
          ? await legacyExtraScenario()
          : await scenario(base, { event: true, tracked: true, photo: true });
      const real = s.kit.env.DB;
      const body = request(s);
      const before = await effects(real, s);
      const keyset =
        change === 'credential keyset'
          ? await first<{ commitment: string }>(
              real,
              'SELECT commitment FROM credential_ref_keyset WHERE id=1',
            )
          : null;
      const trigger =
        change === 'credential keyset'
          ? await first<{ sql: string }>(
              real,
              "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='credential_ref_keyset_no_update'",
            )
          : null;
      if (change === 'credential keyset' && (!keyset || !trigger))
        throw new Error('Missing credential keyset guard');
      if (trigger) await run(real, 'DROP TRIGGER credential_ref_keyset_no_update');
      try {
        const mutation =
          change === 'scanner authority'
            ? stmt(real, 'UPDATE scanners SET revoked_at=? WHERE id=?', [
                s.kit.clock.now(),
                s.scanner.id,
              ])
            : change === 'Wallet snapshot'
              ? stmt(
                  real,
                  `UPDATE pass_versions SET pass_json=json_set(pass_json,'$.voided',json('true'))
                   WHERE pass_id=? AND version=(SELECT max(version) FROM pass_versions WHERE pass_id=?)`,
                  [s.pass.id, s.pass.id],
                )
              : change === 'template extras'
                ? stmt(
                    real,
                    `INSERT INTO template_version_extras
                    (template_id,version,name,size,sha1,sha256,r2_key) VALUES (?,?,?,?,?,?,?)`,
                    [
                      s.template,
                      s.pass.templateVersion,
                      'late-preview.png',
                      0,
                      '1'.repeat(40),
                      '2'.repeat(64),
                      `legacy-extra/${s.template}`,
                    ],
                  )
                : stmt(real, 'UPDATE credential_ref_keyset SET commitment=? WHERE id=1', [
                    keyset?.commitment === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64),
                  ]);
        const outcome = await raceAtBoundary(s, boundary, mutation, body);
        expect(outcome).toMatchObject({
          kind: 'refused',
          reason: 'not_found',
          scanId: null,
          card: null,
          display: null,
        });
        expect(JSON.stringify(outcome)).not.toContain(s.pass.id);
        expect(await effects(real, s)).toEqual(before);
      } finally {
        if (trigger) await run(real, trigger.sql);
      }
    });
  }
});
