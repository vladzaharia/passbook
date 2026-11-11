import { beforeAll, expect } from 'vitest';
import {
  makeSession,
  makeUser,
  type ScannerFixture,
  type StaffFixture,
  withoutTrigger,
} from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { resolveSession } from '../auth/sessions.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import {
  adminActor,
  captureScanTenantAuthority,
  type ScanActor,
  scannerActor,
  withRole,
} from './actor.ts';
import {
  actorCsrfAuthorityStmt,
  actorCsrfSnapshotFence,
  actorCsrfSnapshotFromResult,
} from './actor-csrf.ts';
import { planCounts } from './counts.ts';
import { getScanner } from './repo-device.ts';
import { getEvent, readScannerScope, type ScanEventRow } from './repo-scope.ts';
import { bindScanningSession } from './scanning-workspace.ts';
import { boundStaff } from './staff-binding.ts';
import { grantScanMembership, proofedScanActor, type ScanKit, setupScanKit } from './test-kit.ts';

export let kit: ScanKit;

export interface Scenario {
  actor: ScanActor;
  scanner: ScannerFixture;
  event: ScanEventRow;
  templateId: string;
  passId: string;
  otherTemplateId: string;
  staff: StaffFixture | null;
  sessionId: string | null;
}

export function registerCountsFixture() {
  beforeAll(async () => {
    kit = await setupScanKit({ clockStart: Date.UTC(2026, 0, 1, 12) });
  });
}

export async function scenario(
  options: { staff?: boolean; session?: boolean; admission?: boolean } = {},
): Promise<Scenario> {
  const templateId = await kit.scanTemplate('Counts', {
    actions: [{ id: 'enter', label: 'Check in', kind: 'check_in' }],
  });
  const otherTemplateId = await kit.scanTemplate('Other counts', {
    actions: [{ id: 'enter', label: 'Check in', kind: 'check_in' }],
  });
  const pass = await kit.scanPass(templateId);
  const event = await kit.event({ templateIds: [templateId] });
  const staff = options.staff ? await kit.staff('desk') : null;
  const scanner = await kit.scanner({
    ...(options.admission ? { templateIds: [templateId] } : { eventId: event.id }),
    ...(staff ? { staffId: staff.id, settings: { staffSignIn: true } } : {}),
  });
  let sessionId: string | null = null;
  if (options.session) {
    sessionId = kit.fx.ids.id();
    const accepts = options.admission ? { templateIds: [templateId] } : { eventId: event.id };
    await run(
      kit.env.DB,
      `INSERT INTO scanning_sessions
      (id,org_id,mode,name,status,accepts,settings,time_zone,created_at,updated_at)
      SELECT ?,org_id,mode,name,'active',?,settings,time_zone,created_at,updated_at
      FROM scanners WHERE id=?`,
      [sessionId, JSON.stringify(accepts), scanner.id],
    );
    await run(
      kit.env.DB,
      `INSERT INTO scanning_devices
      (scanner_id,session_id,org_id,mode,surface,effective_surface,overrides)
      SELECT id,?,org_id,mode,'phone','phone','{}' FROM scanners WHERE id=?`,
      [sessionId, scanner.id],
    );
  }
  const row = await getScanner(kit.env.DB, scanner.id);
  if (!row) throw new Error('Missing scanner fixture');
  const scope = await readScannerScope(kit.env.DB, row, staff?.id ?? null);
  const actor = scannerActor(kit.ctx, row, 'live', 'cookie', scope);
  if (sessionId) await bindScanningSession(kit.ctx, actor);
  withRole(actor, scope.staff ? await boundStaff(kit.ctx, row, scope.staff) : null);
  const eventRow = await getEvent(kit.env.DB, kit.org.id, event.id);
  if (!eventRow) throw new Error('Missing event fixture');
  await run(kit.env.DB, 'UPDATE scan_events SET expected=73, expected_at=0 WHERE id=?', [event.id]);
  return {
    actor: await proofedScanActor(kit.ctx, actor),
    scanner,
    event: eventRow,
    templateId,
    passId: pass.id,
    otherTemplateId,
    staff,
    sessionId,
  };
}

export async function adminFor(
  s: Scenario,
  explicit = false,
  templateIds?: readonly string[],
): Promise<ScanActor> {
  const user = await makeUser(kit.fx);
  await grantScanMembership(kit.fx, kit.org.id, user.id);
  const fixture = await makeSession(kit.fx, { userId: user.id, roles: ['admin', 'user'] });
  const auth = await resolveSession(kit.env, kit.clock, fixture.cookieValue);
  if (!auth) throw new Error('Missing admin session');
  const actor = adminActor(auth, 'live', {
    orgId: kit.org.id,
    event: s.event,
    templateIds: [...(templateIds ?? [explicit ? s.otherTemplateId : s.templateId])],
    timeZone: 'UTC',
  });
  const authority = await tenantAuthorityOf(kit.ctx, auth, kit.org.id, 'scanning:manage');
  if (authority.kind !== 'session') throw new Error('Expected a session authority');
  actor.tenantAuthority = await captureScanTenantAuthority(kit.ctx, auth, authority);
  actor.platformSessionId = auth.sessionId;
  actor.adminEventTemplates = !explicit;
  return proofedScanActor(kit.ctx, actor);
}

/** Change the database immediately before the batch containing the cache CAS. */
export function raceCache(mutate: (db: D1Database) => Promise<unknown>) {
  let raced = false;
  const cacheStatements = new WeakSet<D1PreparedStatement>();
  const db = new Proxy(kit.env.DB, {
    get(target, prop) {
      if (prop === 'prepare')
        return (sql: string) => {
          const prepared = target.prepare(sql);
          if (!sql.startsWith('UPDATE scan_events SET expected =')) return prepared;
          return new Proxy(prepared, {
            get(statement, member) {
              if (member === 'bind')
                return (...params: unknown[]) => {
                  const bound = statement.bind(...params);
                  cacheStatements.add(bound);
                  return bound;
                };
              const value = Reflect.get(statement, member, statement);
              return typeof value === 'function' ? value.bind(statement) : value;
            },
          });
        };
      if (prop === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          if (!raced && statements.some((statement) => cacheStatements.has(statement))) {
            raced = true;
            await mutate(target);
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const env: AppEnv = { ...kit.env, DB: db };
  return { ctx: { ...kit.ctx, env } as ServiceContext, raced: () => raced };
}

export async function cache(eventId: string) {
  return first<{ expected: number | null; expected_at: number | null }>(
    kit.env.DB,
    'SELECT expected,expected_at FROM scan_events WHERE id=?',
    [eventId],
  );
}

/** Exercise fences even against a restored or corrupted row, then restore the schema. */
export async function withMutableTrigger(
  name:
    | 'template_releases_immutable'
    | 'credential_ref_keyset_no_update'
    | 'scanners_credential_revision'
    | 'sessions_csrf_secret_immutable',
  work: () => Promise<unknown>,
) {
  await withoutTrigger(kit.env.DB, name, async () => {
    await work();
  });
}

export async function csrfFence(actor: ScanActor) {
  const statement = actorCsrfAuthorityStmt(kit.env.DB, actor);
  if (!statement) throw new Error('Missing CSRF authority statement');
  const snapshot = await actorCsrfSnapshotFromResult(kit.ctx, actor, await statement.all());
  if (!snapshot) throw new Error('Missing verified CSRF snapshot');
  const fence = actorCsrfSnapshotFence(actor, snapshot);
  if (!fence) throw new Error('Missing CSRF authority fence');
  return fence;
}

export async function expectBlocked(
  s: Scenario,
  mutate: (db: D1Database) => Promise<unknown>,
  actor: ScanActor = s.actor,
  authorityActor?: ScanActor,
  expected = 1,
) {
  const race = raceCache(mutate);
  const plan = planCounts(race.ctx, actor, undefined, authorityActor);
  const results = await race.ctx.env.DB.batch(plan.stmts);
  expect(results[3]?.results).toEqual([]);
  expect(results[4]?.results?.[0]).toMatchObject({ n: expected });
  const result = await plan.read(results);
  expect(result.counts.event?.expected).toBe(expected);
  expect(race.raced()).toBe(true);
  expect(await cache(s.event.id)).toEqual({ expected: 73, expected_at: 0 });
}

/** A volatile change (a label, a timestamp) moves no epoch: the cache is still written. */
export async function expectCached(
  s: Scenario,
  mutate: (db: D1Database) => Promise<unknown>,
  actor: ScanActor = s.actor,
) {
  const race = raceCache(mutate);
  const plan = planCounts(race.ctx, actor);
  const results = await race.ctx.env.DB.batch(plan.stmts);
  expect(race.raced()).toBe(true);
  expect(results[3]?.results?.[0]).toMatchObject({ n: 1 });
  expect((await plan.read(results)).counts.event?.expected).toBe(1);
  expect(await cache(s.event.id)).toEqual({ expected: 1, expected_at: kit.clock.now() });
}
