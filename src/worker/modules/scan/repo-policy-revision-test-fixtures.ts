import { expect } from 'vitest';
import { run } from '../../platform/db.ts';
import { scannerActor, withRole } from './actor.ts';
import { getScanner } from './repo-device.ts';
import { readScannerScope } from './repo-scope.ts';
import { key, proofedScanActor, type ScanKit } from './test-kit.ts';

export const CHECK_IN = { id: 'check_in', label: 'Check in', kind: 'check_in' } as const;
type Policy = 'organization' | 'template';

export function policyRevisionHelpers(getKit: () => ScanKit) {
  async function scenario(mode: 'live' | 'test' = 'live', scannerMode: 'live' | 'test' = 'live') {
    const kit = getKit();
    const templateId = await kit.scanTemplate('Revision race', { actions: [CHECK_IN] });
    const pass = await kit.scanPass(
      templateId,
      { memberName: 'Revision Private Person' },
      { mode },
    );
    const scanner = await kit.scanner({
      mode: scannerMode,
      templateIds: [templateId],
      settings: { lookup: true, roleWithoutSignIn: 'desk' },
    });
    const row = await getScanner(kit.env.DB, scanner.id);
    if (!row) throw new Error('Missing scanner fixture');
    const scope = await readScannerScope(kit.env.DB, row, null);
    const actor = await proofedScanActor(
      kit.ctx,
      withRole(scannerActor(kit.ctx, row, row.mode, 'cookie', scope), null),
    );
    return { templateId, pass, scanner, actor };
  }

  async function persistLegacyWallet(pass: { id: string; serial: string }, passJson: object) {
    const kit = getKit();
    await run(kit.env.DB, 'UPDATE pass_versions SET pass_json=? WHERE pass_id=? AND version=1', [
      JSON.stringify({
        ...passJson,
        serialNumber: pass.serial,
        passTypeIdentifier: kit.env.PLATFORM_PASS_TYPE_ID,
        teamIdentifier: kit.env.PLATFORM_TEAM_ID,
      }),
      pass.id,
    ]);
  }

  /** Restore the same policy values, but not the monotonic policy generation. */
  async function changeAwayAndBack(db: D1Database, policy: Policy, templateId: string) {
    const kit = getKit();
    if (policy === 'organization') {
      await run(db, "UPDATE orgs SET status='suspended',updated_at=updated_at+1 WHERE id=?", [
        kit.org.id,
      ]);
      await run(db, "UPDATE orgs SET status='active',updated_at=updated_at+1 WHERE id=?", [
        kit.org.id,
      ]);
    } else {
      await run(db, "UPDATE templates SET status='archived',updated_at=updated_at+1 WHERE id=?", [
        templateId,
      ]);
      await run(db, "UPDATE templates SET status='active',updated_at=updated_at+1 WHERE id=?", [
        templateId,
      ]);
    }
  }

  /**
   * Change policy immediately after the original candidate row came back, whether the candidate
   * read ran alone or inside a batch (resolve and action reads batch it with their fences).
   */
  async function afterCandidateRead<T>(
    passId: string,
    change: (db: D1Database) => Promise<void>,
    work: () => Promise<T>,
  ) {
    const kit = getKit();
    const real = kit.env.DB;
    let fired = false;
    const candidates = new WeakMap<object, D1PreparedStatement>();
    const fire = async (rows: readonly unknown[] | undefined) => {
      if (fired || !rows?.some((row) => (row as { id?: unknown } | null)?.id === passId)) return;
      fired = true;
      await change(real);
    };
    const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
      const proxy = new Proxy(statement, {
        get(target, prop) {
          if (prop === 'bind') return (...values: unknown[]) => wrap(target.bind(...values));
          if (prop === 'first')
            return async () => {
              const row = await target.first();
              await fire([row]);
              return row;
            };
          if (prop === 'all')
            return async () => {
              const result = await target.all();
              await fire(result.results);
              return result;
            };
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      candidates.set(proxy, statement);
      return proxy;
    };
    const db = new Proxy(real, {
      get(target, prop) {
        if (prop === 'prepare')
          return (sql: string) => {
            const statement = target.prepare(sql);
            return sql.includes('AS active_release_candidate_hash') && sql.includes('FROM passes p')
              ? wrap(statement)
              : statement;
          };
        if (prop === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            const results = await target.batch(
              statements.map((statement) => candidates.get(statement) ?? statement),
            );
            for (const [index, statement] of statements.entries())
              if (candidates.has(statement)) await fire(results[index]?.results);
            return results;
          };
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    Object.assign(kit.env, { DB: db });
    try {
      const result = await work();
      expect(fired).toBe(true);
      return result;
    } finally {
      Object.assign(kit.env, { DB: real });
    }
  }

  /** Interleave immediately before or after the atomic gate batch. */
  async function atGate<T>(
    phase: 'before' | 'after',
    change: (db: D1Database) => Promise<void>,
    work: () => Promise<T>,
  ) {
    const kit = getKit();
    const real = kit.env.DB;
    const gateStatements = new WeakSet<D1PreparedStatement>();
    let fired = false;
    const db = new Proxy(real, {
      get(target, prop) {
        if (prop === 'prepare')
          return (sql: string) => {
            const prepared = target.prepare(sql);
            if (!sql.includes('INSERT INTO scan_gates')) return prepared;
            return new Proxy(prepared, {
              get(statement, member) {
                if (member === 'bind')
                  return (...values: unknown[]) => {
                    const bound = statement.bind(...values);
                    gateStatements.add(bound);
                    return bound;
                  };
                const value = Reflect.get(statement, member, statement);
                return typeof value === 'function' ? value.bind(statement) : value;
              },
            });
          };
        if (prop === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            const match = !fired && statements.some((statement) => gateStatements.has(statement));
            if (match && phase === 'before') {
              fired = true;
              await change(real);
            }
            const result = await target.batch(statements);
            if (match && phase === 'after') {
              fired = true;
              await change(real);
            }
            return result;
          };
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    Object.assign(kit.env, { DB: db });
    try {
      const result = await work();
      expect(fired).toBe(true);
      return result;
    } finally {
      Object.assign(kit.env, { DB: real });
    }
  }

  const requestOf = (passId: string) => ({
    idempotencyKey: key(),
    input: { passId, method: 'manual' as const },
    clientTs: getKit().clock.now(),
  });

  return {
    scenario,
    persistLegacyWallet,
    changeAwayAndBack,
    afterCandidateRead,
    atGate,
    requestOf,
  };
}
