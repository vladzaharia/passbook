import { expect } from 'vitest';
import type { ScannerFixture } from '../../../../test/helpers/index.ts';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { all, first, run } from '../../platform/db.ts';
import type { EventRow } from '../events/repo.ts';
import { codeOf, key, makeLegacyScanPass, type ScanKit, setupScanKit } from './test-kit.ts';

export let kit: ScanKit;
export let templateId: string;
export const actions = [
  { id: 'check_in', label: 'Check in', kind: 'check_in' },
  { id: 'other', label: 'Other entry', kind: 'check_in' },
] as const;

export async function setupOverrideProof() {
  kit = await setupScanKit();
  templateId = await kit.scanTemplate('Override provenance', { actions: [...actions] });
}

export interface Scenario {
  scanner: ScannerFixture;
  pass: { id: string };
  input: unknown;
  headsId: string;
  event: EventRow;
}

export async function request(
  scanner: ScannerFixture,
  input: unknown,
  options: Record<string, unknown> = {},
): Promise<Response> {
  return kit.post(scanner.headers, '/actions', {
    idempotencyKey: key(),
    input,
    clientTs: kit.clock.now(),
    actionId: 'check_in',
    ...options,
  });
}

export async function scenario(
  options: { legacy?: boolean; letInAgain?: 'anyone' | 'manager' } = {},
): Promise<Scenario> {
  const template = options.legacy
    ? await kit.scanTemplate(
        'Legacy override provenance',
        { actions: [...actions] },
        { releaseModes: [] },
      )
    : templateId;
  let pass: { id: string };
  let input: unknown;
  if (options.legacy) {
    pass = await makeLegacyScanPass(kit.fx, {
      orgId: kit.org.id,
      template: await kit.registry.resolve(template),
    });
    input = { passId: pass.id, method: 'manual' };
  } else {
    const issued = await kit.scanPass(template);
    pass = issued;
    input = codeOf(issued);
  }
  const scanner = await kit.scanner({
    templateIds: [template],
    settings: { letInAgain: options.letInAgain ?? 'anyone' },
  });
  const firstResponse = await request(scanner, input);
  expect(firstResponse.status).toBe(200);
  expect(await firstResponse.json()).toMatchObject({ kind: 'ok' });
  const response = await request(scanner, input);
  expect(response.status).toBe(200);
  const heads = (await response.json()) as ScanOutcome;
  expect(heads).toMatchObject({ kind: 'heads_up', reason: 'already_done', overridable: true });
  if (!heads.scanId) throw new Error('Missing heads-up scan');
  const event = await first<EventRow>(
    kit.env.DB,
    `SELECT * FROM pass_events
    WHERE pass_id=? AND kind='scan.heads_up' AND json_extract(data,'$.scanId')=?`,
    [pass.id, heads.scanId],
  );
  if (!event) throw new Error('Missing heads-up event');
  return { scanner, pass, input, headsId: heads.scanId, event };
}

export interface CapturedState {
  pass: unknown;
  transfers: unknown[];
  gates: unknown[];
  presence: unknown[];
  scans: unknown[];
  events: unknown[];
  retention: unknown[];
}

export async function state(passId: string, db: D1Database = kit.env.DB): Promise<CapturedState> {
  return {
    pass: await first(db, 'SELECT * FROM passes WHERE id=?', [passId]),
    transfers: await all(
      db,
      'SELECT * FROM pass_credential_transfers WHERE pass_id=? ORDER BY id',
      [passId],
    ),
    gates: await all(db, 'SELECT * FROM scan_gates WHERE pass_id=? ORDER BY action_id,scope', [
      passId,
    ]),
    presence: await all(db, 'SELECT * FROM scan_presence WHERE pass_id=? ORDER BY scope', [passId]),
    scans: await all(db, 'SELECT * FROM scans WHERE pass_id=? ORDER BY id', [passId]),
    events: await all(db, 'SELECT * FROM pass_events WHERE pass_id=? ORDER BY id', [passId]),
    retention: await all(
      db,
      `SELECT r.* FROM scan_retention_proofs r
      JOIN scans q ON q.id=r.scan_id WHERE q.pass_id=? ORDER BY r.scan_id`,
      [passId],
    ),
  };
}

/** Observe attempted gate writes as well as durable effects for rejected original proofs. */
async function withoutGateClaim<T>(work: () => Promise<T>): Promise<T> {
  const real = kit.env.DB;
  let attempted = false;
  const db = new Proxy(real, {
    get(target, prop) {
      if (prop === 'prepare')
        return (sql: string) => {
          if (sql.includes('INSERT INTO scan_gates')) attempted = true;
          return target.prepare(sql);
        };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  Object.assign(kit.env, { DB: db });
  try {
    const result = await work();
    expect(attempted).toBe(false);
    return result;
  } finally {
    Object.assign(kit.env, { DB: real });
  }
}

export async function expectInvalid(s: Scenario, options: Record<string, unknown> = {}) {
  const before = await state(s.pass.id);
  const idempotencyKey = key();
  const response = await withoutGateClaim(() =>
    request(s.scanner, s.input, {
      overrideOf: s.headsId,
      idempotencyKey,
      ...options,
    }),
  );
  expect(response.status).toBe(422);
  expect(await response.json()).toMatchObject({ code: 'SCAN_OVERRIDE_INVALID' });
  expect(await state(s.pass.id)).toEqual(before);
  expect(
    await first(kit.env.DB, 'SELECT id FROM scans WHERE idempotency_key=?', [idempotencyKey]),
  ).toBeNull();
}

export async function duplicateEvent(db: D1Database, eventId: string) {
  await run(
    db,
    `INSERT INTO pass_events (id,org_id,pass_id,mode,kind,device,actor_type,actor_id,data,at)
    SELECT ?,org_id,pass_id,mode,'scan.rejected',device,actor_type,actor_id,data,at
    FROM pass_events WHERE id=?`,
    [kit.fx.ids.ordered(), eventId],
  );
}

/** Interleave with real D1 after verification and immediately before the atomic gate batch. */
export async function atGate<T>(
  change: (db: D1Database) => Promise<void>,
  work: () => Promise<T>,
  env: Pick<ScanKit['env'], 'DB'> = kit.env,
): Promise<T> {
  const real = env.DB;
  const matching = new WeakSet<D1PreparedStatement>();
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
                return (...params: unknown[]) => {
                  const bound = statement.bind(...params);
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
            await change(real);
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  Object.assign(env, { DB: db });
  try {
    const result = await work();
    expect(fired).toBe(true);
    return result;
  } finally {
    Object.assign(env, { DB: real });
  }
}
