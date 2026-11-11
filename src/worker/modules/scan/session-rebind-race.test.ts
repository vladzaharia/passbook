import { beforeAll, describe, expect, it } from 'vitest';
import {
  type EventFixture,
  runOne,
  type ScannerFixture,
  type StaffFixture,
} from '../../../../test/helpers/index.ts';
import type { ScanDeviceCapabilities } from '../../../shared/contracts/scanning-sessions.ts';
import { first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { approveScanReleases, type ScanKit, setupScanKit } from './test-kit.ts';

const CHECK_IN = { id: 'check_in', label: 'Check in', kind: 'check_in' } as const;
const changes = [
  'parent revision',
  'parent name',
  'parent accepts',
  'reparent',
  'device overrides',
  'device surface',
  'device report time',
  'scanner name',
  'event row',
  'event templates',
  'scanner templates',
  'template status',
  'release head',
  'token',
  'csrf',
  'staff rebind',
] as const;
type Change = (typeof changes)[number];
type Phase = 'unbind' | 'before report' | 'after report' | 'final guard' | 'final report';
let kit: ScanKit;
let templateId: string;
let otherTemplateId: string;

beforeAll(async () => {
  kit = await setupScanKit();
  await ensureCredentialRefKeyset(kit.env.DB, kit.env);
  templateId = await kit.scanTemplate('Original rebind scope', { actions: [CHECK_IN] });
  otherTemplateId = await kit.scanTemplate('Other rebind scope', { actions: [CHECK_IN] });
}, 60_000);

const capabilities = (width: number): ScanDeviceCapabilities => ({
  width,
  height: 844,
  touch: true,
  camera: 'available',
  keyboard: true,
  nativeBarcode: false,
  surfaces: ['phone', 'operator', 'customer'],
  preferred: width >= 900 ? 'operator' : 'phone',
});
interface Fixture {
  scanner: ScannerFixture;
  replacement: StaffFixture;
  event: EventFixture;
  sessionId: string;
  otherSessionId: string;
  csrf: string;
  nextToken: string;
  nextCsrf: string;
  prefix: string;
}

async function fixture(withStaff: boolean): Promise<Fixture> {
  const staff = withStaff ? await kit.staff('door') : null;
  const replacement = await kit.staff('manager');
  const event = await kit.event({ templateIds: [templateId] });
  const scanner = await kit.scanner({
    ...(staff ? { staffId: staff.id } : {}),
    settings: { staffSignIn: false },
  });
  const csrf = scanner.headers['x-csrf-token'];
  if (!csrf) throw new Error('Missing scanner CSRF secret.');
  const sessionId = kit.fx.ids.id();
  const otherSessionId = kit.fx.ids.id();
  const now = kit.clock.now();
  await run(
    kit.env.DB,
    `INSERT INTO scanning_sessions
    (id,org_id,mode,name,status,accepts,settings,time_zone,created_at,updated_at)
    SELECT ?,org_id,mode,'Original session','active',?,settings,time_zone,?,? FROM scanners WHERE id=?`,
    [sessionId, JSON.stringify({ eventId: event.id }), now, now, scanner.id],
  );
  await run(
    kit.env.DB,
    `INSERT INTO scanning_sessions
    (id,org_id,mode,name,status,accepts,settings,time_zone,created_at,updated_at)
    SELECT ?,org_id,mode,'Other session',status,accepts,settings,time_zone,created_at,updated_at
    FROM scanning_sessions WHERE id=?`,
    [otherSessionId, sessionId],
  );
  await run(
    kit.env.DB,
    `INSERT INTO scanning_devices
    (scanner_id,session_id,org_id,mode,surface,effective_surface,overrides)
    SELECT id,?,org_id,mode,'auto','phone','{}' FROM scanners WHERE id=?`,
    [sessionId, scanner.id],
  );
  const prefix = kit.fx.ids
    .token(24)
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, 8);
  const nextToken = `wls_${prefix}_${kit.fx.ids.token(32)}`;
  const nextCsrf = kit.fx.ids.token();
  return {
    scanner,
    replacement,
    event,
    sessionId,
    otherSessionId,
    csrf,
    nextToken,
    nextCsrf,
    prefix,
  };
}

interface DeviceState {
  updated_at: number;
  device_role: string;
  staff_id: string | null;
  staff_since: number | null;
  staff_seen_at: number | null;
  token_hash: string;
  token_prefix: string;
  csrf_secret: string;
  session_id: string;
  surface: string;
  effective_surface: string;
  overrides: string;
  capabilities: string | null;
  reported_at: number | null;
}
async function deviceState(db: D1Database, id: string): Promise<DeviceState> {
  const row = await first<DeviceState>(
    db,
    `SELECT s.updated_at,s.device_role,s.staff_id,s.staff_since,
    s.staff_seen_at,s.token_hash,s.token_prefix,s.csrf_secret,d.session_id,d.surface,d.effective_surface,
    d.overrides,d.capabilities,d.reported_at
    FROM scanners s JOIN scanning_devices d ON d.scanner_id=s.id WHERE s.id=?`,
    [id],
  );
  if (!row) throw new Error('Missing paired scanning device.');
  return row;
}

async function changeAtBoundary(db: D1Database, f: Fixture, change: Change) {
  const id = f.scanner.id;
  const mutate = async (sql: string, values: (string | number)[]) => {
    await runOne(db, sql, values);
  };
  switch (change) {
    case 'parent revision':
      return mutate('UPDATE scanning_sessions SET updated_at=updated_at+1 WHERE id=?', [
        f.sessionId,
      ]);
    case 'parent name':
      return mutate('UPDATE scanning_sessions SET name=? WHERE id=?', [
        'Changed parent',
        f.sessionId,
      ]);
    case 'parent accepts':
      return mutate('UPDATE scanning_sessions SET accepts=? WHERE id=?', [
        JSON.stringify({ templateIds: [templateId] }),
        f.sessionId,
      ]);
    case 'reparent':
      return mutate('UPDATE scanning_devices SET session_id=? WHERE scanner_id=?', [
        f.otherSessionId,
        id,
      ]);
    case 'device overrides':
      return mutate('UPDATE scanning_devices SET overrides=? WHERE scanner_id=?', [
        '{"lookup":false}',
        id,
      ]);
    case 'device surface':
      return mutate("UPDATE scanning_devices SET surface='operator' WHERE scanner_id=?", [id]);
    case 'device report time':
      return mutate(
        'UPDATE scanning_devices SET reported_at=COALESCE(reported_at,0)+1 WHERE scanner_id=?',
        [id],
      );
    case 'scanner name':
      return mutate('UPDATE scanners SET name=? WHERE id=?', [`Changed ${id.slice(-8)}`, id]);
    case 'event row':
      return mutate('UPDATE scan_events SET name=?,updated_at=updated_at+1 WHERE id=?', [
        'Changed event',
        f.event.id,
      ]);
    case 'event templates':
      return mutate('INSERT INTO scan_event_templates(event_id,template_id) VALUES(?,?)', [
        f.event.id,
        otherTemplateId,
      ]);
    case 'scanner templates':
      return mutate('INSERT INTO scanner_templates(scanner_id,template_id) VALUES(?,?)', [
        id,
        otherTemplateId,
      ]);
    case 'template status':
      return mutate("UPDATE templates SET status='archived',updated_at=updated_at+1 WHERE id=?", [
        templateId,
      ]);
    case 'release head': {
      const sql = `SELECT generation FROM template_releases WHERE template_id=? AND org_id=? AND mode='live'
        AND provider='apple' ORDER BY generation DESC LIMIT 1`;
      const before = await first<{ generation: number }>(db, sql, [templateId, kit.org.id]);
      if (!before) throw new Error('Missing approved template head.');
      await approveScanReleases(kit, templateId, { modes: ['live'], db });
      expect(await first(db, sql, [templateId, kit.org.id])).toEqual({
        generation: before.generation + 1,
      });
      return;
    }
    case 'token':
      return mutate(
        'UPDATE scanners SET token_hash=?,token_prefix=?,updated_at=updated_at+1 WHERE id=?',
        [await sha256Hex(f.nextToken), f.prefix, id],
      );
    case 'csrf':
      return mutate('UPDATE scanners SET csrf_secret=?,updated_at=updated_at+1 WHERE id=?', [
        f.nextCsrf,
        id,
      ]);
    case 'staff rebind':
      return mutate(
        `UPDATE scanners SET staff_id=?,staff_since=?,staff_seen_at=?,updated_at=updated_at+1 WHERE id=?`,
        [f.replacement.id, kit.clock.now(), kit.clock.now(), id],
      );
  }
}

/** All statements execute on D1; only the boundary between committed work and rebind is interleaved. */
function interleave(real: D1Database, f: Fixture, phase: Phase, change: Change) {
  const marked = new WeakSet<D1PreparedStatement>();
  let hits = 0;
  let before: DeviceState | undefined;
  let after: DeviceState | undefined;
  const mutate = async () => {
    hits++;
    before = await deviceState(real, f.scanner.id);
    await changeAtBoundary(real, f, change);
    after = await deviceState(real, f.scanner.id);
  };
  const db = new Proxy(real, {
    get(target, prop) {
      if (prop === 'prepare')
        return (sql: string) => {
          const prepared = target.prepare(sql);
          // The unbind and the report are each one grant batch: mark their write, run the change
          // around the batch.
          const report =
            ((phase === 'before report' || phase === 'after report') &&
              sql.includes('UPDATE scanning_devices SET capabilities')) ||
            (phase === 'unbind' && /UPDATE scanners SET staff_id = \?/.test(sql));
          const final =
            (phase === 'final guard' || phase === 'final report') &&
            sql.includes('WITH session_scope AS MATERIALIZED (');
          if (!report && !final) return prepared;
          return new Proxy(prepared, {
            get(statement, member) {
              if (member === 'bind')
                return (...values: unknown[]) => {
                  const bound = statement.bind(...values);
                  marked.add(bound);
                  return bound;
                };
              const value = Reflect.get(statement, member, statement);
              return typeof value === 'function' ? value.bind(statement) : value;
            },
          });
        };
      if (prop === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          const index = statements.findIndex((statement) => marked.has(statement));
          if (index < 0 || hits) return target.batch(statements);
          const after = phase === 'after report' || phase === 'unbind';
          if (!after) await mutate();
          const result = await target.batch(statements);
          if (after) await mutate();
          return result;
        };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { db, result: () => ({ hits, before, after }) };
}

function expectedWrite(original: DeviceState, phase: Phase, width: number): DeviceState {
  if (phase === 'unbind' || phase === 'final guard')
    return {
      ...original,
      updated_at: original.updated_at + 1,
      staff_id: null,
      staff_since: null,
      staff_seen_at: null,
    };
  if (phase === 'before report') return original;
  const changed = width >= 900;
  return {
    ...original,
    updated_at: original.updated_at + (changed ? 1 : 0),
    device_role: 'scan',
    effective_surface: changed ? 'operator' : 'phone',
    capabilities: JSON.stringify(capabilities(width)),
    reported_at: kit.clock.now(),
  };
}

interface Outcome {
  status: number;
  code: string | null;
}

/**
 * What the race does to the request, by what moved. Only the credential (token, CSRF secret) unpairs
 * the device. Configuration that moved after the actor derived it is a 409 and the client refetches;
 * a volatile change (names, revisions, report time) refuses nothing where the write is a grant. The
 * session read's column snapshot is still the old one, so a volatile change there is a 409 until it
 * moves to epochs (WP7).
 */
function outcome(phase: Phase, change: Change): Outcome {
  const credential = change === 'token' || change === 'csrf';
  const ok: Outcome = { status: 200, code: null };
  // Names, revisions and report times are timestamps and labels, not authority: nothing refuses.
  const volatile =
    change === 'parent revision' ||
    change === 'parent name' ||
    change === 'device report time' ||
    change === 'scanner name';
  if (phase === 'final guard' || phase === 'final report') {
    // Template status and the release head are not scanner, session or event authority.
    // An event rename moves no epoch.
    if (
      change === 'parent revision' ||
      change === 'template status' ||
      change === 'release head' ||
      change === 'event row'
    )
      return ok;
    // A lost or rotated credential unpairs the device; the rest keeps the generic not-found.
    if (credential) return { status: 401, code: 'SCANNER_REPAIR' };
    return { status: 404, code: 'SCANNING_SESSION_NOT_FOUND' };
  }
  if (phase === 'unbind') {
    if (credential) return { status: 401, code: 'SCANNER_UNAUTHENTICATED' };
    if (
      volatile ||
      change === 'template status' ||
      change === 'release head' ||
      change === 'event row'
    )
      return ok;
    // Configuration that moved (a scanner template change bumps the scanner's config epoch) after the actor derived it: 409, and the client refetches.
    return { status: 409, code: 'SCAN_CONFIG_CHANGED' };
  }
  if (phase === 'before report') {
    if (credential) return { status: 401, code: 'SCANNER_REPAIR' };
    if (change === 'parent revision' || change === 'release head') return ok;
    return { status: 409, code: 'SCANNING_DEVICE_CHANGED' };
  }
  // After the report committed nothing can refuse it: the answer is built from the new state.
  if (change === 'token') return { status: 401, code: 'SCANNER_UNAUTHENTICATED' };
  if (change === 'staff rebind') return { status: 404, code: 'SCANNING_SESSION_NOT_FOUND' };
  return ok;
}

async function exercise(phase: Phase, change: Change, width = 1200) {
  const guard = phase === 'unbind' || phase === 'final guard';
  const f = await fixture(guard);
  const real = kit.env.DB;
  const original = await deviceState(real, f.scanner.id);
  const race = interleave(real, f, phase, change);
  Object.assign(kit.env, { DB: race.db });
  try {
    const response = guard
      ? await kit.get(f.scanner.headers, '/session')
      : await kit.post(f.scanner.headers, '/device', { capabilities: capabilities(width) });
    const text = await response.text();
    const { status, code } = outcome(phase, change);
    const live = status === 200;
    expect(response.status).toBe(status);
    if (code) expect(JSON.parse(text)).toMatchObject({ code });
    for (const secret of live
      ? [f.scanner.token, f.nextToken, f.nextCsrf]
      : [f.scanner.token, f.csrf, f.nextToken, f.nextCsrf, f.sessionId, f.event.id, templateId])
      expect(text).not.toContain(secret);
    const result = race.result();
    expect(result.hits).toBe(1);
    expect(result.before).toEqual(expectedWrite(original, phase, width));
    expect(result.after).toBeDefined();
    const final = await deviceState(real, f.scanner.id);
    // A change before the report that refuses nothing leaves the report to commit after it.
    if (phase === 'before report' && live)
      expect(final).toMatchObject({
        capabilities: JSON.stringify(capabilities(width)),
        reported_at: kit.clock.now(),
      });
    else expect(final).toEqual(result.after);
  } finally {
    Object.assign(kit.env, { DB: real });
    if (change === 'template status')
      await run(
        real,
        "UPDATE templates SET status='active',updated_at=updated_at+1 WHERE id=? AND status='archived'",
        [templateId],
      );
  }
}

describe('session rebind snapshots', () => {
  it('returns the original scoped session after a clean staff unbind', async () => {
    const f = await fixture(true);
    const before = await deviceState(kit.env.DB, f.scanner.id);
    const response = await kit.get(f.scanner.headers, '/session');
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(f.scanner.token);
    expect(JSON.parse(text)).toMatchObject({
      state: 'ready',
      staff: null,
      csrfToken: f.csrf,
      event: { id: f.event.id },
      templates: [expect.objectContaining({ id: templateId })],
      workspace: {
        session: { id: f.sessionId, accepts: { eventId: f.event.id } },
        device: { id: f.scanner.id, effectiveSurface: 'phone', capabilities: null },
      },
    });
    expect(await deviceState(kit.env.DB, f.scanner.id)).toEqual(
      expectedWrite(before, 'unbind', 1200),
    );
  }, 60_000);

  it.each([390, 1200])(
    'returns a clean rebind after reporting width %i',
    async (width) => {
      const f = await fixture(false);
      const before = await deviceState(kit.env.DB, f.scanner.id);
      const response = await kit.post(f.scanner.headers, '/device', {
        capabilities: capabilities(width),
      });
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).not.toContain(f.scanner.token);
      expect(text).not.toContain(f.csrf);
      expect(JSON.parse(text)).toMatchObject({
        session: { id: f.sessionId, accepts: { eventId: f.event.id } },
        device: {
          id: f.scanner.id,
          effectiveSurface: width >= 900 ? 'operator' : 'phone',
          capabilities: capabilities(width),
        },
      });
      expect(await deviceState(kit.env.DB, f.scanner.id)).toEqual(
        expectedWrite(before, 'after report', width),
      );
    },
    60_000,
  );

  it.each(changes)(
    'handles %s between staff unbind and rebind',
    async (change) => {
      await exercise('unbind', change);
    },
    60_000,
  );

  describe.each([390, 1200])('capability width %i', (width) => {
    it.each(changes)(
      'handles %s after the capability commit and before rebind',
      async (change) => {
        await exercise('after report', change, width);
      },
      60_000,
    );
    it.each([
      'parent revision',
      'reparent',
      'device overrides',
      'event templates',
      'release head',
      'token',
      'csrf',
    ] as const)(
      'handles %s before the capability commit',
      async (change) => {
        await exercise('before report', change, width);
      },
      60_000,
    );
  });

  it.each([
    'parent revision',
    'device overrides',
    'event row',
    'event templates',
    'scanner templates',
    'template status',
    'release head',
    'token',
    'csrf',
  ] as const)(
    'rechecks %s at the final authority after staff rebind',
    async (change) => {
      await exercise('final guard', change);
    },
    60_000,
  );
  it.each([
    'parent revision',
    'device overrides',
    'event row',
    'event templates',
    'scanner templates',
    'template status',
    'release head',
    'token',
    'csrf',
  ] as const)(
    'rechecks %s at the final authority after capability rebind',
    async (change) => {
      await exercise('final report', change);
    },
    60_000,
  );
});
