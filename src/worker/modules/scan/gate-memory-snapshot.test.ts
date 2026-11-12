import { beforeAll, expect, it } from 'vitest';
import { first } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { act } from './act.ts';
import type { ActRequest } from './act-claim.ts';
import { scannerActor, withRole } from './actor.ts';
import { getScanner } from './repo-device.ts';
import { readScannerScope } from './repo-scope.ts';
import { key, proofedScanActor, type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
let templateId: string;
beforeAll(async () => {
  kit = await setupScanKit();
  templateId = await kit.scanTemplate('Frozen action input', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in', repeat: 'always' }],
  });
});

it('uses the captured actor and request even when the caller mutates them during preflight', async () => {
  const pass = await kit.scanPass(templateId);
  const scanner = await kit.scanner({ templateIds: [templateId] });
  const row = await getScanner(kit.env.DB, scanner.id);
  if (!row) throw new Error('Missing scanner fixture');
  const scope = await readScannerScope(kit.env.DB, row, null);
  const actor = await proofedScanActor(
    kit.ctx,
    withRole(scannerActor(kit.ctx, row, row.mode, 'cookie', scope), null),
  );
  const actorKey = actor.actorKey;
  const request: ActRequest = {
    input: { passId: pass.id, method: 'manual' },
    idempotencyKey: key(),
    clientTs: kit.clock.now(),
    actionId: 'check_in',
  };
  let fired = false;
  const matching = new WeakSet<D1PreparedStatement>();
  const db = new Proxy(kit.env.DB, {
    get(target, prop) {
      if (prop === 'prepare')
        return (sql: string) => {
          const prepared = target.prepare(sql);
          if (!sql.includes('AS gate') || !sql.includes('AS presence')) return prepared;
          return new Proxy(prepared, {
            get(statement, member) {
              if (member === 'bind')
                return (...args: unknown[]) => {
                  const bound = statement.bind(...args);
                  matching.add(bound);
                  return bound;
                };
              const value = Reflect.get(statement, member, statement);
              return typeof value === 'function' ? value.bind(statement) : value;
            },
          });
        };
      if (prop === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          if (!fired && statements.some((statement) => matching.has(statement))) {
            fired = true;
            actor.actorKey = 's:untrusted-mutated-key';
            actor.actor.id = 'untrusted-mutated-actor';
            request.input.method = 'wedge';
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const env: AppEnv = { ...kit.env, DB: db };
  const outcome = await act({ ...kit.ctx, env }, actor, request);
  expect(fired).toBe(true);
  expect(outcome.outcome).toMatchObject({ kind: 'ok' });
  if (!outcome.outcome.scanId) throw new Error('Missing committed scan');
  const scan = await first(kit.env.DB, 'SELECT actor_key,actor_id,method FROM scans WHERE id=?', [
    outcome.outcome.scanId,
  ]);
  expect(scan).toEqual({ actor_key: actorKey, actor_id: scanner.id, method: 'manual' });
  const event = await first<{ actor_id: string; data: string }>(
    kit.env.DB,
    "SELECT actor_id,data FROM pass_events WHERE json_extract(data,'$.scanId')=?",
    [outcome.outcome.scanId],
  );
  expect(event?.actor_id).toBe(scanner.id);
  expect(event && JSON.parse(event.data)).toMatchObject({ method: 'manual' });
});
