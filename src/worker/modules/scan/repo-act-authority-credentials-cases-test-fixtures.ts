import { expect, it, vi } from 'vitest';
import { withoutTrigger } from '../../../../test/helpers/index.ts';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { first, run } from '../../platform/db.ts';
import { act as actService } from './act.ts';
import { expectBlocked, raceGate } from './act-authority-test-fixtures.ts';
import { CHECK_IN, expectUnavailable, kit, out, rows, tpl } from './act-test-fixtures.ts';
import { scannerActor, withRole } from './actor.ts';
import { commitBatchSql } from './repo-act-support-test-fixtures.ts';
import { getScanner } from './repo-device.ts';
import { readScannerScope } from './repo-scope.ts';
import type { ScanEvaluation } from './scan-evaluation.ts';
import { codeOf, key, proofedScanActor, setupScanKit } from './test-kit.ts';

export function registerAuthorityCredentials() {
  for (const phase of ['admission', 'passless'] as const) {
    it.each(['csrf', 'token'] as const)(
      `does not commit ${phase} after scanner %s credentials change`,
      async (change) => {
        const scanner = await kit.scanner({ templateIds: [tpl] });
        const pass = await kit.scanPass(tpl);
        const input =
          phase === 'admission'
            ? codeOf(pass)
            : { code: `UNKNOWN-CSRF-${key()}`, method: 'camera' };
        const idempotencyKey = key();
        const response = await raceGate(
          scanner.headers,
          input,
          (db) =>
            run(
              db,
              change === 'csrf'
                ? 'UPDATE scanners SET csrf_secret=?,updated_at=updated_at+1 WHERE id=?'
                : 'UPDATE scanners SET token_hash=?,updated_at=updated_at+1 WHERE id=?',
              [change === 'csrf' ? `changed-${key()}` : 'e'.repeat(64), scanner.id],
            ),
          { idempotencyKey },
          phase === 'admission' ? 'INSERT INTO scan_gates' : commitBatchSql,
        );
        // A rotated credential bumps the scanner's credential epoch: a 401 re-pair, not a masked miss.
        await expectBlocked(response, pass.id, idempotencyKey, 'SCANNER_REPAIR');
        expect(
          await rows('SELECT pass_id FROM scan_gates WHERE pass_id=?', [pass.id]),
        ).toHaveLength(0);
        expect(
          await rows('SELECT pass_id FROM scan_presence WHERE pass_id=?', [pass.id]),
        ).toHaveLength(0);
        expect(
          await rows("SELECT id FROM pass_events WHERE pass_id=? AND kind LIKE 'scan.%'", [
            pass.id,
          ]),
        ).toHaveLength(0);
        const counterKey = `scan:miss:${JSON.stringify([kit.org.id, 'live', `s:${scanner.id}`])}`;
        expect(
          await first(kit.env.DB, 'SELECT count FROM counters WHERE key=?', [counterKey]),
        ).toBeNull();
      },
    );
  }

  it.each(['code', 'passId'] as const)(
    'uses one captured keyring for %s credential refs and signed decision across an environment change',
    async (inputKind) => {
      const scanner = await kit.scanner({ templateIds: [tpl] });
      const pass = await kit.scanPass(tpl);
      const scannerRow = await getScanner(kit.env.DB, scanner.id);
      if (!scannerRow) throw new Error('Missing scanner');
      const scope = await readScannerScope(kit.env.DB, scannerRow, null);
      const actor = await proofedScanActor(
        kit.ctx,
        withRole(scannerActor(kit.ctx, scannerRow, 'live', 'cookie', scope), null),
      );
      const input =
        inputKind === 'passId' ? { passId: pass.id, method: 'manual' as const } : codeOf(pass);
      const idempotencyKey = key();
      const keys = Object.fromEntries(
        Object.entries(kit.env).filter(([name]) => /^KEK_V\d+$/.test(name)),
      );
      if (!Object.keys(keys).length) throw new Error('Missing test keyring');
      const pending = actService(kit.ctx, actor, {
        idempotencyKey,
        input,
        actionId: 'auto',
        clientTs: kit.clock.now(),
      });
      let result: ScanEvaluation;
      try {
        for (const name of Object.keys(keys)) Reflect.set(kit.env, name, btoa('x'.repeat(32)));
        result = await pending;
      } finally {
        Object.assign(kit.env, keys);
      }
      expect(result.outcome.kind).toBe('ok');
      if (!result.credentialContext) throw new Error('Missing credential context');
      if (inputKind === 'passId')
        expect(result.credentialContext.credentialTombstoneRefs).toEqual([]);
      else expect(result.credentialContext.credentialTombstoneRefs.length).toBeGreaterThan(0);
      const keyset = await first<{ commitment: string }>(
        kit.env.DB,
        'SELECT commitment FROM credential_ref_keyset WHERE id=1',
      );
      expect(result.credentialContext.credentialKeysetCommitment).toBe(keyset?.commitment);
    },
  );

  it('keeps pass credentials and scanner CSRF out of cloned snapshots and bound values', async () => {
    const scanner = await kit.scanner({ templateIds: [tpl] });
    const pass = await kit.scanPass(tpl);
    const scannerRow = await getScanner(kit.env.DB, scanner.id);
    if (!scannerRow || !pass.scanCode || !scanner.headers['x-csrf-token'])
      throw new Error('Missing credentials');
    const scope = await readScannerScope(kit.env.DB, scannerRow, null);
    const actor = await proofedScanActor(
      kit.ctx,
      withRole(scannerActor(kit.ctx, scannerRow, 'live', 'cookie', scope), null),
    );
    const secrets = [
      pass.authToken,
      pass.downloadToken,
      pass.scanCode,
      scanner.headers['x-csrf-token'],
    ];
    const real = kit.env.DB;
    const binds: { sql: string; values: unknown[] }[] = [];
    const db = new Proxy(real, {
      get(target, prop) {
        if (prop === 'prepare')
          return (sql: string) =>
            new Proxy(target.prepare(sql), {
              get(statement, member) {
                if (member === 'bind')
                  return (...values: unknown[]) => {
                    binds.push({ sql, values });
                    return statement.bind(...values);
                  };
                const value = Reflect.get(statement, member, statement);
                return typeof value === 'function' ? value.bind(statement) : value;
              },
            });
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const clonedSecrets: string[] = [];
    const contains = (value: unknown, secret: string, seen = new WeakSet<object>()): boolean => {
      if (typeof value === 'string') return value.includes(secret);
      if (!value || typeof value !== 'object' || seen.has(value)) return false;
      seen.add(value);
      return Object.values(value).some((item) => contains(item, secret, seen));
    };
    const clone = globalThis.structuredClone;
    const spy = vi.spyOn(globalThis, 'structuredClone').mockImplementation(((
      value: unknown,
      ...options: unknown[]
    ) => {
      for (const secret of secrets) if (contains(value, secret)) clonedSecrets.push(secret);
      return Reflect.apply(clone, globalThis, [value, ...options]);
    }) as typeof structuredClone);
    Object.assign(kit.env, { DB: db });
    let result: ScanEvaluation;
    try {
      result = await actService(kit.ctx, actor, {
        idempotencyKey: key(),
        input: { passId: pass.id, method: 'manual' },
        actionId: 'check_in',
        clientTs: kit.clock.now(),
      });
    } finally {
      spy.mockRestore();
      Object.assign(kit.env, { DB: real });
    }
    expect(result.outcome.kind).toBe('ok');
    expect(clonedSecrets).toEqual([]);
    // Packing is gone. Only the candidate read binds the pass credentials (to match, never to write);
    // no write, grant or ledger statement may carry one.
    const clear = binds
      .flatMap(({ sql, values }) =>
        values
          .filter((v) => typeof v === 'string' && secrets.some((secret) => v.includes(secret)))
          .map(() => sql.replace(/\s+/g, ' ').slice(0, 90)),
      )
      .filter((sql) => !sql.includes('FROM pass_check_in c'));
    expect(clear).toEqual([]);
    for (const secret of secrets) expect(JSON.stringify(result.outcome)).not.toContain(secret);
  });

  for (const passless of [false, true]) {
    it.each(['missing', 'mismatched'] as const)(
      `never writes a %s keyset while replaying a ${passless ? 'passless' : 'pass-backed'} explicit pass ID`,
      async (change) => {
        const isolated = await setupScanKit();
        const templateId = await isolated.scanTemplate('Read-only replay keyset', {
          actions: [CHECK_IN],
        });
        const scanner = await isolated.scanner({ templateIds: [templateId] });
        const pass = await isolated.scanPass(templateId);
        const idempotencyKey = key();
        const body = {
          idempotencyKey,
          input: { passId: passless ? isolated.fx.ids.id() : pass.id, method: 'manual' },
          clientTs: isolated.clock.now(),
          actionId: 'check_in',
        };
        const original = (await (
          await isolated.post(scanner.headers, '/actions', body)
        ).json()) as ScanOutcome;
        expect(original.kind).toBe(passless ? 'refused' : 'ok');
        const db = isolated.env.DB;
        const keyset = await first<{ commitment: string }>(
          db,
          'SELECT commitment FROM credential_ref_keyset WHERE id=1',
        );
        if (!keyset) throw new Error('Missing keyset');
        if (change === 'missing') {
          await withoutTrigger(db, 'credential_ref_keyset_no_delete', () =>
            run(db, 'DELETE FROM credential_ref_keyset WHERE id=1'),
          );
        } else {
          const different = `${keyset.commitment[0] === '0' ? '1' : '0'}${keyset.commitment.slice(1)}`;
          await withoutTrigger(db, 'credential_ref_keyset_no_update', () =>
            run(db, 'UPDATE credential_ref_keyset SET commitment=? WHERE id=1', [different]),
          );
        }
        const writes: string[] = [];
        const observed = new Proxy(db, {
          get(target, prop) {
            if (prop === 'prepare')
              return (sql: string) => {
                if (
                  /^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\s+(?:(?:INTO|FROM)\s+)?(?:credential_ref_keyset|scans|pass_events|scan_gates|scan_presence|scan_retention_proofs|counters)\b/i.test(
                    sql,
                  )
                )
                  writes.push(sql);
                return target.prepare(sql);
              };
            const value = Reflect.get(target, prop, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        Object.assign(isolated.env, { DB: observed });
        try {
          expectUnavailable(
            (await (await isolated.post(scanner.headers, '/actions', body)).json()) as ScanOutcome,
          );
        } finally {
          Object.assign(isolated.env, { DB: db });
        }
        expect(writes).toEqual([]);
        expect(
          await first(db, 'SELECT state,outcome FROM scans WHERE idempotency_key=?', [
            idempotencyKey,
          ]),
        ).toMatchObject({ state: 'done', outcome: passless ? 'refused' : 'ok' });
      },
    );
  }
}
