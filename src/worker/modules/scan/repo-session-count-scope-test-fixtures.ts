import { expect } from 'vitest';
import {
  type Fixtures,
  makeOrg,
  makeSession,
  makeUser,
  type ScannerFixture,
} from '../../../../test/helpers/index.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import { ScanOutcomeSchema } from '../../../shared/contracts/scan.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { first, run, stmt } from '../../platform/db.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import type { Pass } from '../passes/repo-map.ts';
import {
  clearScanRetentionDeleteStmt,
  stageScanRetentionDeleteStmt,
} from './repo-scan-retention.ts';
import {
  scanningSessionRow,
  scanningSessionStats,
  scanningSessionTodayStmt,
} from './repo-scanning-sessions.ts';
import { prepareScanRetentionDelete } from './scan-retention-proof.ts';
import { captureConsoleSessionCountAuthority } from './scanning-session-dto.ts';
import { codeOf, grantScanMembership, key, type ScanKit, setupScanKit } from './test-kit.ts';

export const ACTION = {
  id: 'check_in',
  label: 'Check in',
  kind: 'check_in',
  repeat: 'once',
} as const;
export const SINCE = Date.UTC(2026, 0, 1);

export interface SessionCountScanOptions {
  orgId?: string;
  mode?: Mode;
  templateId?: string;
  actorId?: string;
  state?: 'pending' | 'done' | 'failed';
  outcome?: 'ok' | 'heads_up' | 'refused';
  actionKind?: 'check_in' | 'undo';
  undoneBy?: string;
  at?: number;
}

export async function recordSessionCountScan(
  f: Fixtures,
  orgId: string,
  scannerId: string,
  passId: string | null,
  options: SessionCountScanOptions = {},
) {
  const id = f.ids.id();
  await run(
    f.env.DB,
    `INSERT INTO scans
    (id,org_id,mode,pass_id,template_id,scanner_id,actor_type,actor_id,actor_key,
     idempotency_key,request_hash,method,state,outcome,action_id,action_kind,undone_by,at)
    VALUES (?,?,?,?,?,?,'scanner',?,?,?,?,'camera',?,?,'check_in',?,?,?)`,
    [
      id,
      options.orgId ?? orgId,
      options.mode ?? 'live',
      passId,
      options.templateId ?? null,
      scannerId,
      options.actorId ?? scannerId,
      `s:${scannerId}`,
      id,
      id,
      options.state ?? 'done',
      options.outcome ?? 'ok',
      options.actionKind ?? 'check_in',
      options.undoneBy ?? null,
      options.at ?? f.clock.now(),
    ],
  );
  return id;
}

/** A fresh fixture per test file, with shared scope and provenance assertions. */
export function sessionCountScopeFixture() {
  let kit: ScanKit;
  let templateId: string;
  let foreignOrgId: string;
  let foreignTemplateId: string;
  let reader: SessionAuth;

  async function setup() {
    kit = await setupScanKit();
    kit.clock.set(SINCE + 12 * 60 * 60_000);
    foreignOrgId = (await makeOrg(kit.fx)).id;
    const user = await makeUser(kit.fx);
    await grantScanMembership(kit.fx, kit.org.id, user.id, ['read_only']);
    await grantScanMembership(kit.fx, foreignOrgId, user.id, ['read_only']);
    const session = await makeSession(kit.fx, { userId: user.id });
    const auth = await createSessionStore(kit.env, kit.clock).resolve(session.cookieValue);
    if (!auth) throw new Error('Missing session count reader');
    reader = auth;
    templateId = await kit.scanTemplate('Session count', { actions: [ACTION] });
    foreignTemplateId = await kit.scanTemplate(
      'Foreign session count',
      { actions: [ACTION] },
      { orgId: foreignOrgId },
    );
  }

  async function countAuthority(orgId: string, mode: Mode = 'live') {
    const auth = { ...reader, mode };
    const tenant = await tenantAuthorityOf(kit.ctx, auth, orgId, 'scanning:read');
    return captureConsoleSessionCountAuthority(kit.ctx, auth, tenant);
  }

  async function attach(scanner: ScannerFixture, sessionId: string, mode?: Mode) {
    const result = await run(
      kit.env.DB,
      `INSERT INTO scanning_devices
      (scanner_id,session_id,org_id,mode,surface,effective_surface,overrides)
      SELECT id,?,org_id,COALESCE(?,mode),'phone','phone','{}' FROM scanners WHERE id=?`,
      [sessionId, mode ?? null, scanner.id],
    );
    // The insert also bumps scanners.config_epoch; D1 counts trigger changes.
    expect(result.changes).toBe(2);
  }

  async function workspace(scanner: ScannerFixture, eventId: string) {
    const sessionId = kit.fx.ids.id();
    const result = await run(
      kit.env.DB,
      `INSERT INTO scanning_sessions
      (id,org_id,mode,name,status,accepts,settings,time_zone,created_at,updated_at)
      SELECT ?,org_id,mode,'Count session','active',?,settings,time_zone,created_at,updated_at
      FROM scanners WHERE id=?`,
      [sessionId, JSON.stringify({ eventId }), scanner.id],
    );
    expect(result.changes).toBe(1);
    await attach(scanner, sessionId);
    return sessionId;
  }

  async function record(
    scannerId: string,
    passId: string | null,
    options: SessionCountScanOptions = {},
  ) {
    return recordSessionCountScan(kit.fx, kit.org.id, scannerId, passId, {
      ...options,
      templateId: options.templateId ?? templateId,
    });
  }

  async function expectCounts(
    sessionId: string,
    today: number,
    devices: number,
    online: number,
    mode: Mode = 'live',
  ) {
    const row = await scanningSessionRow(kit.env.DB, kit.org.id, sessionId);
    if (!row) throw new Error('Missing scanning session');
    const stats = await scanningSessionStats(
      kit.env.DB,
      row,
      SINCE,
      kit.clock.now() - 120_000,
      await countAuthority(kit.org.id, mode),
      kit.clock.now(),
    );
    const count = await scanningSessionTodayStmt(
      kit.env.DB,
      kit.org.id,
      sessionId,
      mode,
      SINCE,
    ).first<{ n: number }>();
    expect(stats).toEqual({ devices, online, today });
    expect(count).toEqual({ n: today });
    expect(stats?.today).toBe(count?.n);
  }

  async function releaseOf(passId: string) {
    const row = await first<{ release_id: string | null }>(
      kit.env.DB,
      'SELECT release_id FROM passes WHERE id=?',
      [passId],
    );
    if (!row?.release_id) throw new Error('Missing issued release');
    return row.release_id;
  }

  async function checkedIn(scanner: ScannerFixture, pass: Pass) {
    const response = await kit.post(scanner.headers, '/actions', {
      idempotencyKey: key(),
      input: codeOf(pass),
      clientTs: kit.clock.now(),
      actionId: ACTION.id,
    });
    expect(response.status).toBe(200);
    const outcome = ScanOutcomeSchema.parse(await response.json());
    expect(outcome.kind).toBe('ok');
    if (!outcome.scanId) throw new Error('Missing check-in scan');
    return outcome.scanId;
  }

  async function hardDelete(pass: Pass) {
    const prepared = await prepareScanRetentionDelete(kit.env, pass);
    const results = await kit.env.DB.batch([
      stageScanRetentionDeleteStmt(kit.env.DB, pass.id, prepared),
      stmt(kit.env.DB, 'DELETE FROM passes WHERE id=? RETURNING id', [pass.id]),
      clearScanRetentionDeleteStmt(kit.env.DB, prepared),
    ]);
    expect(results[1]?.results).toHaveLength(1);
  }

  // Simulate corrupt persisted provenance without weakening the permanent invalidation guards.
  async function misScopeProof(scanId: string, scannerId: string) {
    await run(
      kit.env.DB,
      `CREATE TRIGGER session_count_skip_invalidation
      BEFORE UPDATE ON scan_retention_proofs WHEN NEW.invalidated=1 AND OLD.invalidated=0
      BEGIN SELECT RAISE(IGNORE); END`,
    );
    try {
      await run(
        kit.env.DB,
        `UPDATE scans SET org_id=?,mode='live',scanner_id=?,actor_id=?,
        actor_key=?,template_id=?,event_id=NULL WHERE id=?`,
        [kit.org.id, scannerId, scannerId, `s:${scannerId}`, templateId, scanId],
      );
    } finally {
      await run(kit.env.DB, 'DROP TRIGGER IF EXISTS session_count_skip_invalidation');
    }
  }

  return {
    setup,
    get kit() {
      return kit;
    },
    get templateId() {
      return templateId;
    },
    get foreignOrgId() {
      return foreignOrgId;
    },
    get foreignTemplateId() {
      return foreignTemplateId;
    },
    countAuthority,
    attach,
    workspace,
    record,
    expectCounts,
    releaseOf,
    checkedIn,
    hardDelete,
    misScopeProof,
  };
}
