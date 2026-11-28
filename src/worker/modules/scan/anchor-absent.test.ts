import type { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { runOne } from '../../../../test/helpers/exact-rows.ts';
import { type makeEnv, makeScanner } from '../../../../test/helpers/index.ts';
import type { AppBindings } from '../../platform/context.ts';
import type { ScanActor } from './actor.ts';
import { createGuardHarness, get } from './guard-test-fixtures.ts';
import { collidingClaimStmt } from './repo-act-claim-current.ts';
import { lookupGateStmt } from './repo-lookup-final.ts';
import {
  apiKeyReadAuthority,
  type ScanReadAuthority,
  scanAuthorizedStmt,
  scanReadAuthority,
  withSessionRow,
} from './repo-read-authority.ts';
import { previewActorStmt, previewCurrentStmt } from './repo-routes-display.ts';
import type { ScanRow } from './repo-scans.ts';
import { orgBrandingForActorStmt } from './repo-session.ts';
import { readStaffActivity } from './repo-staff-activity.ts';

/*
 * Every production statement anchored on `actor_ok` answers "not authorised" for an absent actor:
 * `authorized` is 0 and no foreign column is readable. The source scan keeps the list complete.
 */

const harness = createGuardHarness();
let { f, clock, orgId } = harness;
const build: typeof harness.build = async (...args) => {
  const result = await harness.build(...args);
  ({ f, clock, orgId } = harness);
  return result;
};

describe('anchor statements for an absent actor', () => {
  let app: Hono<AppBindings>;
  let env: Awaited<ReturnType<typeof makeEnv>>;
  beforeEach(async () => {
    ({ app, env } = await build());
  });

  async function revokedActor(): Promise<{ live: ScanActor; scannerId: string }> {
    const s = await makeScanner(f, { orgId });
    expect((await get(app, env, '/capture-read', s.headers)).status).toBe(200);
    const live = harness.capturedActor;
    if (!live) throw new Error('no actor');
    await runOne(env.DB, 'UPDATE scanners SET revoked_at = ? WHERE id = ?', [clock.now(), s.id]);
    return { live, scannerId: s.id };
  }

  const rows = async (stmt: D1PreparedStatement | null) => {
    if (!stmt) throw new Error('no statement');
    return (await stmt.all()).results;
  };
  const scanRow = {
    id: 'x',
    at: 1,
    state: 'accepted',
    reason: null,
    requestHash: 'h',
  } as unknown as ScanRow;
  const candidate = {
    pass: { id: 'p', templateId: 't', credentialGeneration: 1, lifecycleGeneration: 1 },
    templateSnapshot: { raw: '{"release":null}' },
  } as unknown as Parameters<typeof previewCurrentStmt>[2];

  function statements(fresh: () => ScanReadAuthority): Record<string, D1PreparedStatement | null> {
    return {
      scanAuthorizedStmt: scanAuthorizedStmt(env.DB, fresh()),
      collidingClaimStmt: collidingClaimStmt(env.DB, fresh(), 'k', scanRow, 'idem'),
      lookupGateStmt: lookupGateStmt(env.DB, fresh()),
      previewActorStmt: previewActorStmt(env.DB, fresh()),
      previewCurrentStmt: previewCurrentStmt(env.DB, fresh(), candidate),
    };
  }

  it('answers authorized 0 for a revoked scanner on every stamped statement', async () => {
    const { live } = await revokedActor();
    const fresh = () => scanReadAuthority(live, { now: clock.now() });
    for (const [name, stmt] of Object.entries(statements(fresh))) {
      const [row] = await rows(stmt);
      const stamp = row?.authorized as number | undefined;
      expect(stamp, name).toBe(0);
      if (row && 'pass_ok' in row) expect(row.pass_ok, name).toBe(0);
    }
  });

  it('answers authorized 0 for a platform key that does not exist, with and without a named org', async () => {
    const now = clock.now();
    for (const named of [undefined, orgId]) {
      const fresh = () => apiKeyReadAuthority({ keyId: 'no-such-key', orgId: null }, named, now);
      for (const [name, stmt] of Object.entries(statements(fresh))) {
        const [row] = await rows(stmt);
        const stamp = row?.authorized as number | undefined;
        expect(stamp, `${name} ${named ?? 'all orgs'}`).toBe(0);
      }
    }
  });

  it('returns no branding row for an absent actor', async () => {
    const { live } = await revokedActor();
    const auth = scanReadAuthority(live, { now: clock.now() });
    expect(await rows(orgBrandingForActorStmt(env.DB, auth))).toEqual([]);
  });

  it('returns one row with auth_ok 0 and no person for an absent actor', async () => {
    const { live } = await revokedActor();
    const auth = scanReadAuthority(live, { now: clock.now() });
    const out = await readStaffActivity(
      env.DB,
      auth,
      ['America/Los_Angeles'],
      clock.now(),
      { limit: 10 },
      'UTC',
    );
    expect(out.map((r) => [r.auth_ok, r.m_id])).toEqual([[0, null]]);
  });

  describe('the scanning session gate', () => {
    const base = {
      id: 'ss-anchor',
      mode: 'live',
      name: 'S',
      status: 'active',
      settings: '{}',
      time_zone: 'UTC',
    };
    const authorized = async (auth: ScanReadAuthority) =>
      (await rows(scanAuthorizedStmt(env.DB, auth)))[0]?.authorized;

    let seq = 0;
    async function liveActor(): Promise<ScanActor> {
      const s = await makeScanner(f, { orgId });
      expect((await get(app, env, '/capture-read', s.headers)).status).toBe(200);
      const live = harness.capturedActor;
      if (!live) throw new Error('no actor');
      return live;
    }

    async function sessionRow() {
      seq += 1;
      const id = `ss-anchor-${seq}-${f.ids.id()}`;
      await runOne(
        env.DB,
        `INSERT INTO scanning_sessions (id, org_id, mode, name, status, settings, time_zone, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, orgId, base.mode, base.name, base.status, base.settings, base.time_zone, 1, 1],
      );
      const row = await env.DB.prepare(
        'SELECT id, org_id, mode, config_epoch FROM scanning_sessions WHERE id = ?',
      )
        .bind(id)
        .first<{ id: string; org_id: string; mode: string; config_epoch: number }>();
      if (!row) throw new Error('no session');
      return row;
    }

    it('is 1 for the session row read and 0 once its epoch moved', async () => {
      const live = await liveActor();
      const auth = scanReadAuthority(live, { now: clock.now() });
      const row = await sessionRow();
      expect(await authorized(withSessionRow(auth, row))).toBe(1);
      await runOne(env.DB, "UPDATE scanning_sessions SET status = 'paused' WHERE id = ?", [row.id]);
      expect(await authorized(withSessionRow(auth, row))).toBe(0);
    });

    it('is 0 when the session row was read under another org', async () => {
      const live = await liveActor();
      const auth = scanReadAuthority(live, { now: clock.now() });
      const row = await sessionRow();
      expect(await authorized(withSessionRow(auth, { ...row, org_id: 'other-org' }))).toBe(0);
    });

    it('is 0 for a revoked scanner even when the session row still matches', async () => {
      const live = await liveActor();
      const row = await sessionRow();
      await runOne(env.DB, 'UPDATE scanners SET revoked_at = ? WHERE id = ?', [
        clock.now(),
        live.scanner?.id ?? '',
      ]);
      const auth = scanReadAuthority(live, { now: clock.now() });
      expect(await authorized(withSessionRow(auth, row))).toBe(0);
    });
  });

  it('lists every production use of the anchor', () => {
    const sources = import.meta.glob('/src/worker/**/*.ts', {
      query: '?raw',
      import: 'default',
      eager: true,
    });
    const users = Object.entries(sources)
      .filter(
        ([path, text]) => !/\.test\.ts$/.test(path) && /\$\{[\w.]*\.anchor\}/.test(text as string),
      )
      .map(([path]) => path.replace('/src/worker/', ''))
      .sort();
    expect(users).toEqual([
      'modules/scan/repo-act-claim-current.ts',
      'modules/scan/repo-lookup-final.ts',
      'modules/scan/repo-read-authority.ts',
      'modules/scan/repo-routes-display.ts',
      'modules/scan/repo-session.ts',
      'modules/scan/repo-staff-activity.ts',
    ]);
  });
});
