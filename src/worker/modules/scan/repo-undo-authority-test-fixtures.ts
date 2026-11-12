import { beforeEach, expect } from 'vitest';
import { makePass, persistTemplate, type ScannerFixture } from '../../../../test/helpers/index.ts';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { first, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { ICON_PNG } from '../passes/pass-test-fixtures.ts';
import type { Pass } from '../passes/repo-map.ts';
import { type ScanActor, scannerActor, withRole } from './actor.ts';
import { captureScanEpochs } from './authority-checks.ts';
import { getScanner, type ScannerRow, scannerEpochsOf } from './repo-device.ts';
import { candidateById } from './repo-lookup.ts';
import { readScannerScope } from './repo-scope.ts';
import { boundStaff } from './staff-binding.ts';
import { codeOf, key, proofedScanActor, type ScanKit, setupScanKit } from './test-kit.ts';

export let kit: ScanKit;
export let templateId: string;
beforeEach(async () => {
  kit = await setupScanKit({ clockStart: Date.UTC(2026, 0, 1, 12) });
  templateId = await kit.scanTemplate('Undo authority', {
    actions: [{ id: 'enter', label: 'Check in', kind: 'check_in' }],
  });
});

/** The epochs the guard captures on a real request: the actor derived from `row`, checked by grants. */
export async function withEpochs(row: ScannerRow, actor: ScanActor): Promise<ScanActor> {
  const pinHash = actor.staff
    ? (
        await first<{ pin_hash: string }>(
          kit.env.DB,
          'SELECT pin_hash FROM scan_staff WHERE id=?',
          [actor.staff.id],
        )
      )?.pin_hash
    : undefined;
  await captureScanEpochs(kit.env.DB, actor, scannerEpochsOf(row), pinHash);
  return actor;
}

export interface Scenario {
  scanner: ScannerFixture;
  actor: ScanActor;
  pass: Pass;
  targetId: string;
}

export async function scenario(
  eventId?: string,
  staffId?: string,
  connectionId?: string,
  mode: 'live' | 'test' = 'live',
  checkIn: { mode: string } | null = { mode: 'in_out' },
  template = templateId,
): Promise<Scenario> {
  const scanner = await kit.scanner({
    mode,
    ...(eventId ? { eventId } : { templateIds: [template] }),
    ...(staffId ? { staffId } : {}),
    settings: { ...(checkIn ? { checkIn } : {}), direction: 'both', staffSignIn: !!staffId },
  });
  const pass = await kit.scanPass(template, {}, { mode });
  if (connectionId)
    await run(kit.env.DB, 'UPDATE passes SET connection_id=? WHERE id=?', [connectionId, pass.id]);
  const response = await kit.post(scanner.headers, '/actions', {
    idempotencyKey: key(),
    input: codeOf(pass),
    clientTs: kit.clock.now(),
    actionId: 'enter',
  });
  expect(response.status).toBe(200);
  const outcome = (await response.json()) as ScanOutcome;
  expect(outcome.kind).toBe('ok');
  if (!outcome.scanId) throw new Error('Missing check-in scan');
  const actor = await actorFor(scanner.id, mode, staffId);
  return { scanner, pass, targetId: outcome.scanId, actor };
}

/** The actor the guard would build for a paired scanner, with its epochs. */
export async function actorFor(
  scannerId: string,
  mode: 'live' | 'test' = 'live',
  staffId?: string,
): Promise<ScanActor> {
  const row = await getScanner(kit.env.DB, scannerId);
  if (!row) throw new Error('Missing scanner');
  const scope = await readScannerScope(kit.env.DB, row, staffId ?? null);
  return withEpochs(
    row,
    await proofedScanActor(
      kit.ctx,
      withRole(
        scannerActor(kit.ctx, row, mode, 'cookie', scope),
        scope.staff ? await boundStaff(kit.ctx, row, scope.staff) : null,
      ),
    ),
  );
}

/** A scan by the scenario's scanner for `pass`; returns the outcome. */
export async function scanAgain(s: Scenario, pass = s.pass): Promise<ScanOutcome> {
  const response = await kit.post(s.scanner.headers, '/actions', {
    idempotencyKey: key(),
    input: codeOf(pass),
    clientTs: kit.clock.now(),
    actionId: 'enter',
  });
  expect(response.status).toBe(200);
  return (await response.json()) as ScanOutcome;
}

export async function legacyScenario(): Promise<
  Scenario & { legacyTemplateId: string; version: string }
> {
  const legacyTemplateId = await kit.scanTemplate(
    'Legacy undo',
    {
      actions: [{ id: 'enter', label: 'Check in', kind: 'check_in' }],
    },
    { releaseModes: ['test'] },
  );
  const template = await kit.registry.resolve(legacyTemplateId);
  const inserted = await makePass(kit.fx, { orgId: kit.org.id, template });
  await run(kit.env.DB, 'UPDATE pass_versions SET pass_json=? WHERE pass_id=? AND version=1', [
    JSON.stringify({
      ...template.passJson,
      serialNumber: inserted.serial,
      passTypeIdentifier: kit.env.PLATFORM_PASS_TYPE_ID,
      teamIdentifier: kit.env.PLATFORM_TEAM_ID,
    }),
    inserted.id,
  ]);
  const candidate = await candidateById(kit.env.DB, kit.org.id, inserted.id);
  if (!candidate || candidate.pass.releaseId !== null) throw new Error('Missing legacy pass');
  const scanner = await kit.scanner({
    templateIds: [legacyTemplateId],
    settings: { checkIn: { mode: 'in_out' }, direction: 'both' },
  });
  const response = await kit.post(scanner.headers, '/actions', {
    idempotencyKey: key(),
    input: { passId: inserted.id, method: 'manual' },
    clientTs: kit.clock.now(),
    actionId: 'enter',
  });
  const outcome = (await response.json()) as ScanOutcome;
  expect(outcome.kind).toBe('ok');
  if (!outcome.scanId) throw new Error('Missing legacy check-in');
  const row = await getScanner(kit.env.DB, scanner.id);
  if (!row) throw new Error('Missing scanner');
  const scope = await readScannerScope(kit.env.DB, row, null);
  const actor = await withEpochs(
    row,
    await proofedScanActor(
      kit.ctx,
      withRole(scannerActor(kit.ctx, row, 'live', 'cookie', scope), null),
    ),
  );
  return {
    scanner,
    actor,
    pass: candidate.pass,
    targetId: outcome.scanId,
    legacyTemplateId,
    version: template.version,
  };
}

export async function connection(): Promise<string> {
  const id = kit.fx.ids.id();
  await run(
    kit.env.DB,
    `INSERT INTO connections
    (id,org_id,connector_type,name,created_at,updated_at) VALUES (?,?,'demo','Demo',?,?)`,
    [id, kit.org.id, kit.clock.now(), kit.clock.now()],
  );
  return id;
}

/** Approve a different version and then roll back through a new head to the original version. */
export async function rollReleaseAwayAndBack(db: D1Database) {
  const pinned = await kit.registry.resolve(templateId, 'v1');
  const next = kit.registry.add({
    id: templateId,
    orgId: kit.org.id,
    version: 'v2',
    manifest: pinned.manifest,
    passJson: pinned.passJson,
    assets: { 'icon.png': ICON_PNG },
  });
  await persistTemplate(kit.fx, next, { registry: kit.registry });
  await approveAppleRelease(kit, { templateId, db, mode: 'test', version: next.version });
  await approveAppleRelease(kit, { templateId, db, mode: 'test', version: pinned.version });
}

/** Run a mutation just before a particular transaction, after all its preflight reads. */
export function raceBatch(
  sqlPart: string,
  mutate: (db: D1Database) => Promise<unknown>,
): { ctx: ServiceContext; raced: () => boolean } {
  const matching = new WeakSet<D1PreparedStatement>();
  let invoked = false;
  const db = new Proxy(kit.env.DB, {
    get(target, prop) {
      if (prop === 'prepare')
        return (sql: string) => {
          const prepared = target.prepare(sql);
          if (!sql.includes(sqlPart)) return prepared;
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
          if (!invoked && statements.some((statement) => matching.has(statement))) {
            invoked = true;
            await mutate(target);
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const env: AppEnv = { ...kit.env, DB: db };
  return { ctx: { ...kit.ctx, env }, raced: () => invoked };
}

export async function expectNoUndo(s: Scenario, undoKey: string) {
  expect(
    await first(kit.env.DB, 'SELECT id FROM scans WHERE actor_key=? AND idempotency_key=?', [
      s.actor.actorKey,
      undoKey,
    ]),
  ).toBeNull();
  expect(await first(kit.env.DB, 'SELECT undone_by FROM scans WHERE id=?', [s.targetId])).toEqual({
    undone_by: null,
  });
  expect(
    await first(kit.env.DB, 'SELECT last_scan_id FROM scan_gates WHERE pass_id=?', [s.pass.id]),
  ).toEqual({ last_scan_id: s.targetId });
  expect(
    await first(kit.env.DB, "SELECT id FROM pass_events WHERE pass_id=? AND kind='scan.undone'", [
      s.pass.id,
    ]),
  ).toBeNull();
  expect(
    await first(kit.env.DB, "SELECT id FROM audit_log WHERE target_id=? AND action='scan.undo'", [
      s.targetId,
    ]),
  ).toBeNull();
  expect(
    await first(kit.env.DB, 'SELECT last_scan_id FROM scan_presence WHERE pass_id=?', [s.pass.id]),
  ).toEqual({ last_scan_id: s.targetId });
}
