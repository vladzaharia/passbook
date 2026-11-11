import { beforeAll, expect } from 'vitest';
import { makeSession, makeUser } from '../../../../test/helpers/index.ts';
import {
  CreateScanningDeviceSchema,
  CreateScanningSessionSchema,
  type ScanDeviceCapabilities,
} from '../../../shared/contracts/scanning-sessions.ts';
import { all, first, run } from '../../platform/db.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import { scannerActor, scanScannerCsrfProof } from './actor.ts';
import { captureScanEpochs } from './authority-checks.ts';
import { pairHere } from './pairing-token.ts';
import { getScanner, scannerEpochsOf } from './repo-device.ts';
import { getConsoleScanner } from './repo-scanners.ts';
import { readScannerScope } from './repo-scope.ts';
import { scanSecretSlots } from './repo-secret-binds.ts';
import { createScanningDevice } from './scanning-devices.ts';
import { captureConsoleSessionCountAuthority } from './scanning-session-dto.ts';
import { createScanningSession } from './scanning-sessions.ts';
import { bindScanningSession } from './scanning-workspace.ts';
import { grantScanMembership, type ScanKit, setupScanKit } from './test-kit.ts';

export const ORIGIN = 'https://wallet.test';
export let kit: ScanKit;

export function registerScannerCapabilityFixture() {
  beforeAll(async () => {
    kit = await setupScanKit();
  });
}

export const capabilities = (width: number): ScanDeviceCapabilities => ({
  width,
  height: 844,
  touch: true,
  camera: 'available',
  keyboard: true,
  nativeBarcode: false,
  surfaces: ['phone', 'operator', 'customer'],
  preferred: 'phone',
});

export async function fixture() {
  const user = await makeUser(kit.fx);
  await grantScanMembership(kit.fx, kit.org.id, user.id);
  const login = await makeSession(kit.fx, { userId: user.id, roles: ['user'] });
  const auth = await createSessionStore(kit.env, kit.clock).resolve(login.cookieValue);
  if (!auth) throw new Error('Missing platform session.');
  const authority = await tenantAuthorityOf(kit.ctx, auth, kit.org.id, 'scanning:manage');
  if (authority.kind !== 'session') throw new Error('Missing session authority.');
  const countAuthority = await captureConsoleSessionCountAuthority(
    kit.ctx,
    auth,
    await tenantAuthorityOf(kit.ctx, auth, kit.org.id, 'scanning:read'),
  );
  const session = await createScanningSession(
    kit.ctx,
    user.id,
    'live',
    CreateScanningSessionSchema.parse({
      orgId: kit.org.id,
      name: `Report ${kit.fx.ids.token(5)}`,
      timeZone: 'UTC',
      accepts: null,
    }),
    authority,
    countAuthority,
  );
  const device = await createScanningDevice(
    kit.ctx,
    user.id,
    'live',
    session.id,
    CreateScanningDeviceSchema.parse({ name: `Device ${kit.fx.ids.token(5)}`, surface: 'auto' }),
    ORIGIN,
    authority,
  );
  const row = await getConsoleScanner(kit.env.DB, device.id);
  if (!row) throw new Error('Missing device.');
  const paired = await pairHere(kit.ctx, user.id, row, undefined, authority);
  if (!paired.csrfSecret) throw new Error('Missing scanner CSRF secret.');
  return { user, auth, authority, session, device, secret: paired.csrfSecret, token: paired.token };
}

export async function pairedActor(id: string) {
  const row = await getScanner(kit.env.DB, id);
  if (!row?.csrfSecret) throw new Error('Missing paired scanner.');
  const actor = scannerActor(
    kit.ctx,
    { ...row, csrfSecret: null },
    row.mode,
    'cookie',
    await readScannerScope(kit.env.DB, row, null),
  );
  actor.scannerCsrfProof = await scanScannerCsrfProof(kit.env, row.id, row.csrfSecret);
  await bindScanningSession(kit.ctx, actor);
  await captureScanEpochs(kit.env.DB, actor, scannerEpochsOf(row));
  return actor;
}

export async function deviceState(id: string) {
  return {
    device: await first(
      kit.env.DB,
      `SELECT s.device_role,d.surface,d.effective_surface,d.capabilities,d.reported_at
      FROM scanners s JOIN scanning_devices d ON d.scanner_id=s.id WHERE s.id=?`,
      [id],
    ),
    audit: await all(kit.env.DB, 'SELECT * FROM audit_log WHERE target_id=? ORDER BY id', [id]),
    revisions: await all(
      kit.env.DB,
      'SELECT * FROM scanning_config_revisions WHERE target_id=? ORDER BY kind,revision',
      [id],
    ),
  };
}

/** Observe the actual final statements, optionally racing just before their transaction. */
export function intercept(db: D1Database, race?: () => Promise<void>) {
  const statements = new WeakSet<D1PreparedStatement>();
  const writes: { sql: string; values: unknown[] }[] = [];
  let fired = false;
  const proxy = new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare')
        return (sql: string) => {
          const prepared = target.prepare(sql);
          if (
            !sql.includes('INSERT INTO scanning_config_revisions') &&
            !sql.includes('UPDATE scanning_devices SET capabilities')
          )
            return prepared;
          return new Proxy(prepared, {
            get(statement, member) {
              if (member === 'bind')
                return (...values: unknown[]) => {
                  const bound = statement.bind(...values);
                  statements.add(bound);
                  writes.push({ sql, values });
                  return bound;
                };
              const value = Reflect.get(statement, member, statement);
              return typeof value === 'function' ? value.bind(statement) : value;
            },
          });
        };
      if (prop === 'batch')
        return async (prepared: D1PreparedStatement[]) => {
          if (!fired && prepared.some((statement) => statements.has(statement))) {
            fired = true;
            if (race) await race();
          }
          return target.batch(prepared);
        };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { db: proxy, writes, fired: () => fired };
}

export async function revokeCapabilityPlatformSession(
  db: D1Database,
  now: number,
  sessionId: string,
) {
  await run(db, 'UPDATE sessions SET revoked_at=? WHERE id_hash=?', [now, sessionId]);
}

export function expectScalarSecret(
  writes: { sql: string; values: unknown[] }[],
  secret: string,
  label: string,
) {
  expect(writes.length).toBeGreaterThan(0);
  for (const { sql, values } of writes) {
    const slots = scanSecretSlots(sql, values.length);
    expect(sql).toContain('json(?) AS data');
    expect(slots).not.toBeNull();
    const positions = values.flatMap((value, index) => (value === secret ? [index] : []));
    expect(positions).toHaveLength(1);
    if (!slots) throw new Error('Expected SQL secret slots');
    const position = positions[0];
    if (position === undefined) throw new Error('Expected a unique SQL secret slot');
    expect(slots[position]?.label).toBe(label);
    for (const value of values)
      if (typeof value === 'string' && value !== secret) expect(value).not.toContain(secret);
  }
}
