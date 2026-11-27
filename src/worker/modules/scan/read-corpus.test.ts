import type { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { runOne } from '../../../../test/helpers/exact-rows.ts';
import {
  type makeEnv,
  makeScanEvent,
  makeScanner,
  makeScanStaff,
  makeTemplate,
} from '../../../../test/helpers/index.ts';
import type { AppBindings } from '../../platform/context.ts';
import type { SqlValue } from '../../platform/db.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import type { ScanActor } from './actor.ts';
import { effectiveReleaseIs } from './effective-release.ts';
import { createGuardHarness, get } from './guard-test-fixtures.ts';
import { pinKeyset } from './keyset-pin.ts';
import { countScanRows } from './repo-feed.ts';
import { scanAuthorizedStmt, scanRead, scanReadAuthority } from './repo-read-authority.ts';
import { legacyOf } from './repo-read-once-legacy-auth.ts';
import {
  legacyActorFenceStmt,
  legacyAuthorizedStmt,
  legacyBrandingStmt,
  legacyFeedCountStmt,
} from './repo-read-once-legacy-more.ts';
import { passlessStmt } from './repo-resolve-passless-read.ts';
import { orgBrandingForActorStmt } from './repo-session.ts';
import { copyScanEpochs, scanEpochsOf, setScanEpochs } from './scan-epochs.ts';

/*
 * The scan read primitives compile on local D1 without the balancer: the fence is the grant's own
 * checks as CTEs, so a read at its maximal shape stays under the bind and depth limits.
 */

const harness = createGuardHarness();
let { f, clock, orgId } = harness;
const build: typeof harness.build = async (...args) => {
  const result = await harness.build(...args);
  ({ f, clock, orgId } = harness);
  return result;
};

describe('scan read corpus', () => {
  let app: Hono<AppBindings>;
  let env: Awaited<ReturnType<typeof makeEnv>>;
  beforeEach(async () => {
    ({ app, env } = await build());
  });

  async function capture(headers: Record<string, string>): Promise<ScanActor> {
    expect((await get(app, env, '/capture-read', headers)).status).toBe(200);
    const actor = harness.capturedActor;
    if (!actor) throw new Error('no actor');
    return actor;
  }

  /** A staffed scanner on an event, plus a session and a second event: the widest fence. */
  async function maximal() {
    const template = makeTemplate({ id: f.ids.id(), orgId });
    await harness.persistApprovedTemplate(template);
    const event = await makeScanEvent(f, { orgId, templateIds: [template.resolved.id] });
    const staff = await makeScanStaff(f, { orgId, role: 'manager' });
    const s = await makeScanner(f, {
      orgId,
      eventId: event.id,
      settings: { staffSignIn: true },
      staffId: staff.id,
    });
    const real = await capture(s.headers);
    const actor: ScanActor = {
      ...real,
      scanningSession: { id: 'ss-1', status: 'active', updatedAt: 1 },
    };
    const epochs = scanEpochsOf(real);
    if (!epochs) throw new Error('no epochs');
    setScanEpochs(actor, { ...structuredClone(epochs), session: { id: 'ss-1', config: 1 } });
    const other = real.event ? { ...real.event, id: 'other-event' } : null;
    return { real, actor, other, templateId: template.resolved.id };
  }

  const FEED_FILTERS: SqlValue[] = Array.from({ length: 13 }, (_, i) => `f${i}`);

  it('the widest fence plus a feed-shaped read stays under 90 binds and compiles', async () => {
    const { actor, other, templateId } = await maximal();
    const auth = scanReadAuthority(actor, { now: clock.now(), event: other, templateId });
    expect(auth.params.length).toBeLessThanOrEqual(40);
    const stmt = scanRead(
      env.DB,
      auth,
      `SELECT x.id FROM ${auth.rows}scans x JOIN passes p ON p.id = x.pass_id
        WHERE ${auth.present} AND ${auth.tenantOnce('x', 'scans')}
          AND x.outcome IN (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          AND ${effectiveReleaseIs('p')}
        LIMIT 50`,
      [...FEED_FILTERS, null],
    );
    expect((await stmt.all()).results).toEqual([]);
  });

  it('a read over 90 binds is refused before it reaches D1', async () => {
    const { real } = await maximal();
    const auth = scanReadAuthority(real, { now: clock.now() });
    expect(() =>
      scanRead(
        env.DB,
        auth,
        'SELECT 1',
        Array.from({ length: 91 }, () => 1),
      ),
    ).toThrow(/SQL_BIND_BUDGET|binds/);
  });

  it('actor_ok is a positive control for the live actor and empty once revoked', async () => {
    const s = await makeScanner(f, { orgId });
    const actor = await capture(s.headers);
    const read = () =>
      scanRead(
        env.DB,
        scanReadAuthority(actor, { now: clock.now() }),
        'SELECT ao.present FROM actor_ok ao',
      ).all();
    expect((await read()).results).toHaveLength(1);
    await runOne(env.DB, 'UPDATE scanners SET revoked_at = ? WHERE id = ?', [clock.now(), s.id]);
    expect((await read()).results).toHaveLength(0);
  });

  it('a paused session needs the read option and a staffless monitor skips the staff check', async () => {
    const { actor } = await maximal();
    const paused: ScanActor = {
      ...actor,
      scanningSession: { id: 'ss-1', status: 'paused', updatedAt: 1 },
    };
    copyScanEpochs(actor, paused);
    const strict = scanReadAuthority(paused, { now: clock.now() });
    const relaxed = scanReadAuthority(paused, { now: clock.now(), read: { pausedSession: true } });
    expect(relaxed.params.length).toBeGreaterThan(strict.params.length);
    await scanRead(env.DB, relaxed, 'SELECT ao.present FROM actor_ok ao').all();

    const monitor: ScanActor = {
      ...actor,
      staff: null,
      role: null,
      scanner: actor.scanner ? { ...actor.scanner, deviceRole: 'monitor' } : null,
    };
    const base = scanReadAuthority(monitor, { now: clock.now() });
    const skipped = scanReadAuthority(monitor, {
      now: clock.now(),
      read: { stafflessMonitor: true },
    });
    expect(skipped.params.length).toBeLessThan(base.params.length);
  });

  it('a staffed session scanner reads what its scalar-form fence read, live and once revoked', async () => {
    const { real } = await maximal();
    const actor = real;
    const auth = scanReadAuthority(actor, { now: clock.now() });
    const old = legacyOf(auth);
    const inner = { sql: 'EXISTS (SELECT 1 FROM passes p WHERE p.org_id = ao.org_id)', params: [] };
    const filter = { mode: 'live', limit: 5, orgId } as const;
    const rows = async (stmt: D1PreparedStatement) => (await stmt.all()).results;
    const compare = async () => {
      expect(await rows(scanAuthorizedStmt(env.DB, auth))).toEqual(
        await rows(legacyAuthorizedStmt(env.DB, old)),
      );
      expect(await rows(orgBrandingForActorStmt(env.DB, auth))).toEqual(
        await rows(legacyBrandingStmt(env.DB, old)),
      );
      expect(await rows(passlessStmt(env.DB, auth, [inner]))).toEqual(
        await rows(legacyActorFenceStmt(env.DB, old, inner)),
      );
      const [was] = await rows(legacyFeedCountStmt(env.DB, old, filter, 10));
      expect((await countScanRows(env.DB, auth, filter, 10)).n).toBe(
        (await rows(legacyAuthorizedStmt(env.DB, old))).length ? (was as { n: number }).n : 0,
      );
    };
    await compare();
    expect(await rows(scanAuthorizedStmt(env.DB, auth))).toEqual([{ authorized: 1 }]);
    await runOne(env.DB, 'UPDATE scanners SET revoked_at = ? WHERE id = ?', [
      clock.now(),
      actor.scanner?.id ?? '',
    ]);
    await compare();
    expect(await rows(scanAuthorizedStmt(env.DB, auth))).toEqual([{ authorized: 0 }]);
  });

  it('pinKeyset reads the keyset once per context and again for another', async () => {
    await ensureCredentialRefKeyset(env.DB, env);
    let reads = 0;
    const prepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = (sql: string) => {
      if (sql.includes('credential_ref_keyset')) reads += 1;
      return prepare(sql);
    };
    const ctx = createServiceContext(env, { clock });
    const pinned = await pinKeyset(ctx);
    expect(await pinKeyset(ctx)).toBe(pinned);
    expect(reads).toBe(1);
    expect(await pinKeyset(createServiceContext(env, { clock }))).toBe(pinned);
    expect(reads).toBe(2);
  });
});
