import { beforeAll, describe, expect, it } from 'vitest';
import { all, first, run } from '../../platform/db.ts';
import type { Pass } from '../passes/repo-map.ts';
import { barcodeHashOfCode, cleanCode } from './codes.ts';
import { credentialTombstoneRefsForInput } from './credential-input.ts';
import {
  codeOf,
  key,
  type ScanKit,
  setupScanKit,
  startScanCredentialTransfer,
} from './test-kit.ts';

let kit: ScanKit;
let onceId: string;
let managerOnlyId: string;
beforeAll(async () => {
  kit = await setupScanKit();
  onceId = await kit.scanTemplate('Retired credential grants', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in', repeat: 'once' }],
  });
  managerOnlyId = await kit.scanTemplate('Retired credential approval', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in', minRole: 'manager' }],
  });
});

/** Retire the presented code through another pass's real transfer (a shared barcode hash). */
async function retire(db: D1Database, pass: Pass, other: Pass) {
  const input = codeOf(pass);
  const refs = await credentialTombstoneRefsForInput(kit.ctx, pass.orgId, pass.mode, input, false);
  const ref = refs.credentialTombstoneRefs[0];
  if (!ref) throw new Error('Missing credential reference');
  await run(db, 'UPDATE passes SET barcode_hash=?,revision=revision+1 WHERE id=?', [
    await barcodeHashOfCode(cleanCode(input.code)),
    other.id,
  ]);
  expect((await startScanCredentialTransfer(kit, other.id, { db })).state).toBe('completed');
  expect(
    await first(db, 'SELECT 1 AS hit FROM pass_credential_tombstones WHERE credential_hash=?', [
      ref,
    ]),
  ).toEqual({ hit: 1 });
}

/** Run `change` just before the batch that opens a grant with `purpose`. */
async function beforeGrant<T>(
  purpose: string,
  change: (db: D1Database) => Promise<void>,
  work: () => Promise<T>,
): Promise<T> {
  const real = kit.env.DB;
  const matches = new WeakSet<D1PreparedStatement>();
  let fired = false;
  const db = new Proxy(real, {
    get(target, prop) {
      if (prop === 'prepare')
        return (sql: string) => {
          const prepared = target.prepare(sql);
          if (!sql.includes('INSERT INTO authority_grants')) return prepared;
          return new Proxy(prepared, {
            get(statement, member) {
              if (member === 'bind')
                return (...values: unknown[]) => {
                  const bound = statement.bind(...values);
                  if (values.includes(purpose)) matches.add(bound);
                  return bound;
                };
              const value = Reflect.get(statement, member, statement);
              return typeof value === 'function' ? value.bind(statement) : value;
            },
          });
        };
      if (prop === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          if (!fired && statements.some((statement) => matches.has(statement))) {
            fired = true;
            await change(target);
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  Object.assign(kit.env, { DB: db });
  try {
    const value = await work();
    expect(fired).toBe(true);
    return value;
  } finally {
    Object.assign(kit.env, { DB: real });
  }
}

const ledger = (passId: string) =>
  all(kit.env.DB, "SELECT id FROM pass_events WHERE pass_id=? AND kind LIKE 'scan.%'", [passId]);

interface Case {
  purpose: string;
  /** A pass and scanner that reach the grant, and the request to send. */
  setup(): Promise<{ pass: Pass; headers: Record<string, string>; body: object }>;
  admitted: object;
}

const cases: [string, Case][] = [
  [
    'held heads-up',
    {
      purpose: 'org_mode.scan.held',
      async setup() {
        const pass = await kit.scanPass(onceId);
        const scanner = await kit.scanner({ templateIds: [onceId] });
        const first = await kit.post(scanner.headers, '/actions', {
          input: codeOf(pass),
          idempotencyKey: key(),
          clientTs: kit.clock.now(),
          actionId: 'check_in',
        });
        expect(await first.json()).toMatchObject({ kind: 'ok' });
        return { pass, headers: scanner.headers, body: { actionId: 'check_in' } };
      },
      admitted: { kind: 'heads_up', reason: 'already_done' },
    },
  ],
  [
    'pass-bearing stop',
    {
      purpose: 'org_mode.scan.stop',
      async setup() {
        const pass = await kit.scanPass(onceId);
        await run(kit.env.DB, "UPDATE passes SET status='voided' WHERE id=?", [pass.id]);
        const scanner = await kit.scanner({ templateIds: [onceId] });
        return { pass, headers: scanner.headers, body: { actionId: 'check_in' } };
      },
      admitted: { kind: 'refused', reason: 'voided' },
    },
  ],
  [
    'choose',
    {
      purpose: 'org_mode.scan.stop',
      async setup() {
        const pass = await kit.scanPass(onceId);
        const scanner = await kit.scanner({ templateIds: [onceId], settings: { flow: 'choose' } });
        return { pass, headers: scanner.headers, body: { actionId: 'auto' } };
      },
      admitted: { kind: 'ready' },
    },
  ],
  [
    'approval answer',
    {
      purpose: 'org_mode.scan.stop',
      async setup() {
        const pass = await kit.scanPass(managerOnlyId);
        const scanner = await kit.scanner({ templateIds: [managerOnlyId] });
        return { pass, headers: scanner.headers, body: { actionId: 'check_in' } };
      },
      admitted: { kind: 'heads_up', reason: 'needs_approval' },
    },
  ],
];

describe('scan commit grants and a presented credential retired after resolve', () => {
  it.each(cases)('%s: admits when nothing retires the credential', async (_label, c) => {
    const { pass, headers, body } = await c.setup();
    const response = await beforeGrant(
      c.purpose,
      async () => {},
      () =>
        kit.post(headers, '/actions', {
          input: codeOf(pass),
          idempotencyKey: key(),
          clientTs: kit.clock.now(),
          ...body,
        }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject(c.admitted);
  });

  it.each(cases)('%s: refuses and records nothing', async (_label, c) => {
    const { pass, headers, body } = await c.setup();
    const other = await kit.scanPass(pass.templateId);
    const before = await ledger(pass.id);
    const idempotencyKey = key();
    const response = await beforeGrant(
      c.purpose,
      (db) => retire(db, pass, other),
      () =>
        kit.post(headers, '/actions', {
          input: codeOf(pass),
          idempotencyKey,
          clientTs: kit.clock.now(),
          ...body,
        }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'SCAN_PASS_CHANGED' });
    expect(await ledger(pass.id)).toEqual(before);
    const row = await first<{ outcome: string | null; pass_id: string | null }>(
      kit.env.DB,
      'SELECT outcome,pass_id FROM scans WHERE idempotency_key=?',
      [idempotencyKey],
    );
    if (row) expect(row).toEqual({ outcome: null, pass_id: null });
  });
});
