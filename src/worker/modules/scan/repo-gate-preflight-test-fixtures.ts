import { expect } from 'vitest';
import type { ScannerFixture } from '../../../../test/helpers/index.ts';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { all, first } from '../../platform/db.ts';
import type { EventRow } from '../events/repo.ts';
import type { Pass } from '../passes/repo-map.ts';
import type { GateKey } from './repo-gates.ts';
import {
  type ScanEffectSnapshot,
  type ScanSignedEffectSnapshot,
  signedEffectSnapshot,
} from './repo-scan-effect.ts';
import { scanById } from './repo-scans.ts';
import { scanActionIdRef } from './scan-action-ref.ts';
import { verifyScanEventProvenance } from './scan-event-proof.ts';
import { codeOf, key, type ScanKit, setupScanKit } from './test-kit.ts';

export let kit: ScanKit;
export let templateId: string;

export async function setupGatePreflight() {
  kit = await setupScanKit();
  templateId = await kit.scanTemplate('Gate preflight', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in', repeat: 'always' }],
  });
}

interface Scenario {
  pass: Pass;
  scanner: ScannerFixture;
  gate: GateKey;
}
export interface CapturedState {
  gate: unknown[];
  presence: unknown[];
  scans: unknown[];
  events: unknown[];
  proofs: unknown[];
}

export async function scenario(): Promise<Scenario> {
  const pass = await kit.scanPass(templateId);
  const scanner = await kit.scanner({
    templateIds: [templateId],
    settings: { checkIn: { mode: 'in_out' }, direction: 'both' },
  });
  return { pass, scanner, gate: { passId: pass.id, actionId: 'check_in', scope: '' } };
}

export async function action(s: Scenario, idempotencyKey = key()): Promise<ScanOutcome> {
  const response = await kit.post(s.scanner.headers, '/actions', {
    input: codeOf(s.pass),
    idempotencyKey,
    clientTs: kit.clock.now(),
    actionId: 'check_in',
  });
  expect(response.status).toBe(200);
  return (await response.json()) as ScanOutcome;
}

export async function state(pass: Pass): Promise<CapturedState> {
  return {
    gate: await all(
      kit.env.DB,
      'SELECT * FROM scan_gates WHERE pass_id=? ORDER BY action_id,scope',
      [pass.id],
    ),
    presence: await all(kit.env.DB, 'SELECT * FROM scan_presence WHERE pass_id=? ORDER BY scope', [
      pass.id,
    ]),
    scans: await all(kit.env.DB, 'SELECT * FROM scans WHERE pass_id=? ORDER BY id', [pass.id]),
    events: await all(
      kit.env.DB,
      "SELECT * FROM pass_events WHERE pass_id=? AND kind LIKE 'scan.%' ORDER BY id",
      [pass.id],
    ),
    proofs: await all(
      kit.env.DB,
      'SELECT r.* FROM scan_retention_proofs r JOIN pass_events e ON e.id=r.ledger_event_id WHERE e.pass_id=? ORDER BY r.scan_id',
      [pass.id],
    ),
  };
}

/** Interleave against real D1 after signing and just before the atomic gate batch. */
export async function atGate<T>(
  change: (db: D1Database) => Promise<void>,
  work: () => Promise<T>,
): Promise<T> {
  const real = kit.env.DB;
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
  Object.assign(kit.env, { DB: db });
  try {
    const result = await work();
    expect(fired).toBe(true);
    return result;
  } finally {
    Object.assign(kit.env, { DB: real });
  }
}

/** Change a planned presence after admission read, but before the bounded effect read. */
export async function beforeEffectRead<T>(
  change: (db: D1Database) => Promise<void>,
  work: () => Promise<T>,
): Promise<T> {
  const real = kit.env.DB;
  let fired = false;
  const matching = new WeakSet<D1PreparedStatement>();
  const db = new Proxy(real, {
    get(target, prop) {
      if (prop === 'prepare')
        return (sql: string) => {
          const prepared = target.prepare(sql);
          if (!sql.includes('AS gate') || !sql.includes('AS presence')) return prepared;
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
  Object.assign(kit.env, { DB: db });
  try {
    const result = await work();
    expect(fired).toBe(true);
    return result;
  } finally {
    Object.assign(kit.env, { DB: real });
  }
}

export async function expectStaleWithoutEffects(
  s: Scenario,
  requestKey: string,
  observed: CapturedState,
) {
  expect(await state(s.pass)).toEqual(observed);
  expect(
    await first(kit.env.DB, 'SELECT state,reason,pass_id FROM scans WHERE idempotency_key=?', [
      requestKey,
    ]),
  ).toEqual({ state: 'failed', reason: 'stale', pass_id: null });
  expect(await action(s, requestKey)).toMatchObject({ kind: 'refused', reason: 'not_found' });
  expect(await state(s.pass)).toEqual(observed);
}

export async function signedEffect(s: Scenario, scanId: string, expected: ScanEffectSnapshot) {
  const row = await first<EventRow>(
    kit.env.DB,
    "SELECT * FROM pass_events WHERE pass_id=? AND json_extract(data,'$.scanId')=?",
    [s.pass.id, scanId],
  );
  const scan = await scanById(kit.env.DB, kit.org.id, scanId);
  if (!row || !scan) throw new Error('Missing scan evidence');
  const data = JSON.parse(row.data) as {
    actionIdRef: string;
    authority: {
      effect: ScanSignedEffectSnapshot;
      pinnedTemplateVersion: string;
      walletVersion: number;
      walletTemplateVersion: string | null;
      eventProof: { mac: string };
    };
  };
  const ref = await scanActionIdRef(kit.env, {
    orgId: s.pass.orgId,
    mode: s.pass.mode,
    templateId: s.pass.templateId,
    actionId: s.gate.actionId,
  });
  expect(data.actionIdRef).toBe(ref);
  expect(Object.hasOwn(data, 'actionId')).toBe(false);
  const authority = data.authority;
  expect(authority.eventProof.mac).toMatch(/^[0-9a-f]{64}$/);
  expect(
    await verifyScanEventProvenance(kit.env, row, {
      ...scan,
      pinnedTemplateVersion: authority.pinnedTemplateVersion,
      walletVersion: authority.walletVersion,
      walletTemplateVersion: authority.walletTemplateVersion,
      direction: scan.direction ?? null,
      presenceScope: scan.presenceScope ?? null,
    }),
  ).toBe(true);
  expect(authority.effect).toEqual(signedEffectSnapshot(expected, ref));
  for (const gate of [authority.effect.gateBefore, authority.effect.gateAfter])
    if (gate) expect(Object.hasOwn(gate, 'actionId')).toBe(false);
}
