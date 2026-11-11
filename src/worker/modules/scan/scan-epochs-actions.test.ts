import { beforeAll, expect, it } from 'vitest';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { first, run } from '../../platform/db.ts';
import { key, type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
beforeAll(async () => {
  kit = await setupScanKit();
});

/** Run `mutate` once, just before the first batch that claims the scan. */
function raceBeforeClaim(mutate: () => Promise<unknown>) {
  const real = kit.env.DB;
  const sqlOf = new WeakMap<object, string>();
  let fired = false;
  const db = new Proxy(real, {
    get(target, prop) {
      if (prop === 'prepare')
        return (sql: string) => {
          const prepared = target.prepare(sql);
          sqlOf.set(prepared, sql);
          return new Proxy(prepared, {
            get(statement, member) {
              if (member === 'bind')
                return (...values: unknown[]) => {
                  const bound = statement.bind(...values);
                  sqlOf.set(bound, sql);
                  return bound;
                };
              const value = Reflect.get(statement, member, statement);
              return typeof value === 'function' ? value.bind(statement) : value;
            },
          });
        };
      if (prop === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          if (!fired && statements.some((s) => sqlOf.get(s)?.includes('INSERT INTO scans'))) {
            fired = true;
            await mutate();
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  Object.assign(kit.env, { DB: db });
  return { fired: () => fired, restore: () => Object.assign(kit.env, { DB: real }) };
}

async function setup() {
  const templateId = await kit.scanTemplate('Epoch liveness', {
    actions: [{ id: 'enter', label: 'Admit member', kind: 'check_in' }],
  });
  const pass = await kit.scanPass(templateId);
  const event = await kit.event({ templateIds: [templateId] });
  const scanner = await kit.scanner({ eventId: event.id });
  const act = async () => {
    const response = await kit.post(scanner.headers, '/actions', {
      idempotencyKey: key(),
      input: { passId: pass.id, method: 'manual' },
      clientTs: kit.clock.now(),
      actionId: 'enter',
    });
    return { status: response.status, body: (await response.json()) as ScanOutcome };
  };
  return { event, act };
}

it('commits an event scan when the event is renamed (a volatile change) before the claim', async () => {
  const { event, act } = await setup();
  const race = raceBeforeClaim(() =>
    run(kit.env.DB, "UPDATE scan_events SET name='Renamed', updated_at=updated_at+9 WHERE id=?", [
      event.id,
    ]),
  );
  try {
    const { status, body } = await act();
    expect(race.fired()).toBe(true);
    expect(status).toBe(200);
    expect(body.kind).toBe('ok');
  } finally {
    race.restore();
  }
  expect(
    await first(kit.env.DB, "SELECT name FROM scan_events WHERE id=? AND name='Renamed'", [
      event.id,
    ]),
  ).not.toBeNull();
});

it('refuses an event scan when the event window changes before the claim', async () => {
  const { event, act } = await setup();
  const race = raceBeforeClaim(() =>
    run(kit.env.DB, 'UPDATE scan_events SET closes_at=closes_at+1 WHERE id=?', [event.id]),
  );
  try {
    const { body } = await act();
    expect(race.fired()).toBe(true);
    expect(body.kind).not.toBe('ok');
  } finally {
    race.restore();
  }
});
