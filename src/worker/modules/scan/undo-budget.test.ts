import { expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { getScanner } from './repo-device.ts';
import { undoGrant } from './repo-undo.ts';
import { kit, scenario, templateId, withEpochs } from './repo-undo-authority-test-fixtures.ts';
import { readUndo } from './repo-undo-read.ts';
import { bindScanningSession } from './scanning-workspace.ts';
import { key } from './test-kit.ts';
import { undo } from './undo.ts';
import { planUndo } from './undo-authority.ts';

/** Count every D1 call: a batch is one round trip, as is each first/all/run. */
function counted() {
  const calls: string[] = [];
  const note = (kind: string, sql?: string) =>
    calls.push(`${kind}${sql ? ` ${sql.slice(0, 60)}` : ''}`);
  const db = new Proxy(kit.env.DB, {
    get(target, prop) {
      if (prop === 'prepare')
        return (sql: string) => {
          const statement = target.prepare(sql);
          return new Proxy(statement, {
            get(s, member) {
              if (member === 'bind')
                return (...v: unknown[]) => {
                  const bound = s.bind(...v);
                  return new Proxy(bound, {
                    get(b, m) {
                      const value = Reflect.get(b, m, b);
                      if (typeof value !== 'function') return value;
                      return (...args: unknown[]) => {
                        if (m === 'first' || m === 'all' || m === 'run' || m === 'raw')
                          note(String(m), sql);
                        return value.apply(b, args);
                      };
                    },
                  });
                };
              const value = Reflect.get(s, member, s);
              return typeof value === 'function' ? value.bind(s) : value;
            },
          });
        };
      if (prop === 'batch')
        return (statements: D1PreparedStatement[]) => {
          note('batch');
          return target.batch(statements);
        };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const env: AppEnv = { ...kit.env, DB: db };
  return { ctx: { ...kit.ctx, env }, calls };
}

it('stays inside the bind limits with every actor part at once', async () => {
  const { staff, s, event } = await full();
  const read = await readUndo(kit.env.DB, kit.org.id, s.actor.actorKey, key(), s.targetId);
  const plan = await planUndo(s.actor, read);
  const g = undoGrant({
    ctx: kit.ctx,
    actor: s.actor,
    ...plan,
    approver: { id: staff.id, authEpoch: 1 },
    id: kit.fx.ids.ordered(),
    key: key(),
  });
  const { grant, writes } = g.inspect();
  expect(grant.params).toBeLessThanOrEqual(90);
  for (const w of writes) expect(w.params).toBeLessThanOrEqual(40);
  expect(event.id).toBeTruthy();
});

it('takes few round trips: a read batch, settings, the commit and the answer', async () => {
  // The answer reads the pass and the counts in parallel, so it is one hop for two calls.
  const hops = (calls: string[]) => calls.length - 1;
  const s = await scenario();
  const plain = counted();
  await undo(plain.ctx, s.actor, s.targetId, { idempotencyKey: key() });
  expect(plain.calls.filter((c) => c === 'batch')).toHaveLength(3);
  expect(hops(plain.calls)).toBeLessThanOrEqual(4);

  const approved = await full();
  kit.clock.advance(11 * 60_000);
  const withApproval = counted();
  await undo(withApproval.ctx, approved.s.actor, approved.s.targetId, {
    idempotencyKey: key(),
    approval: { staffId: approved.manager.id, pin: approved.manager.pin },
  });
  // Plus the PIN reservation and its refund.
  expect(hops(withApproval.calls)).toBeLessThanOrEqual(6);
});

async function full() {
  const event = await kit.event({ templateIds: [templateId] });
  const staff = await kit.staff('door');
  const manager = await kit.staff('manager');
  const s = await scenario(event.id, staff.id);
  const sessionId = kit.fx.ids.id();
  await run(
    kit.env.DB,
    `INSERT INTO scanning_sessions (id,org_id,mode,name,status,accepts,settings,time_zone,created_at,updated_at)
     SELECT ?,org_id,mode,name,'active',?,settings,time_zone,created_at,updated_at FROM scanners WHERE id=?`,
    [sessionId, JSON.stringify({ templateIds: [templateId] }), s.scanner.id],
  );
  await run(
    kit.env.DB,
    `INSERT INTO scanning_devices (scanner_id,session_id,org_id,mode,surface,effective_surface,overrides)
     SELECT id,?,org_id,mode,'phone','phone','{}' FROM scanners WHERE id=?`,
    [sessionId, s.scanner.id],
  );
  await bindScanningSession(kit.ctx, s.actor);
  const row = await getScanner(kit.env.DB, s.scanner.id);
  if (!row) throw new Error('Missing scanner');
  await withEpochs(row, s.actor);
  return { staff, manager, s, event };
}
